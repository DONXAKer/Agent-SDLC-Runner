/**
 * Этап 5 по шагам плана (`ModelDef.stepFill`): цикл ведёт рантайм, модель отвечает на один
 * шаг без tool-use (`exec/StepExecutor.ts`). Здесь — карта шагов и проверка после шага.
 */

import { localResultBytes } from '../../../config/limits.ts';
import { readArtifact } from '../../../artifacts/artifact.ts';
import { extractFilesToTouch } from '../../../artifacts/planFiles.ts';
import { describeStep, planSteps } from '../../../artifacts/planSteps.ts';
import type { ResolvedRoute } from '../../../config/schema.ts';
import { StepExecutor, mentionsFile } from '../../../exec/StepExecutor.ts';
import type { StepCheck } from '../../../exec/StepExecutor.ts';
import { gateKey } from '../../../gates/gatesFile.ts';
import type { GateRow, GatesFile } from '../../../gates/gatesFile.ts';
import { normalizePlanPath } from '../../../policy/paths.ts';
import { humanFactsBlock } from '../../../prompt/build.ts';
import { createProvider } from '../../../provider/registry.ts';
import type { StageHost } from '../types.ts';
import { runNamedGate } from './evidence.ts';

/**
 * Какие строки гейтов прогонять ПОСЛЕ конкретного шага этапа 5 по шагам (`stepFill`,
 * флоу без tool-use, `StepExecutor.ts`).
 *
 * «Сборка» и «Тесты» — ОБЕ безусловно, если включены. Раньше «Тесты» подключалась только
 * для шага, что пишет файл, похожий на тестовый (`TEST_FILE`) — идея была не гонять сьют
 * на промежуточном состоянии продуктового кода, чтобы не путать ложный красный (код ещё
 * не дописан целиком) с настоящим сигналом. Живой замер поймал дыру этого сужения
 * (docs/model-runs.md, три модели независимо: `ministral3-14b-reasoning-stepfill`,
 * `lmstudio:qwen3-8b-stepfill` — идентичные 14/10/4): шаг продуктового кода ломает СВОЙ ЖЕ
 * файл (забытый импорт, `ReferenceError` только в рантайме, не при загрузке модуля —
 * «Сборка» такое не ловит), красный «Тесты» всплывает только на следующем шаге с
 * тестовым файлом, а чинить уже нечем — ремонт того шага не имеет прав на чужой файл, и
 * плана «вернуться» к уже закрытому шагу нет. Опасение «ложный красный на промежуточном
 * состоянии» ложную тревогу не создаёт — от неё и так защищает `mentionsFile()` ниже по
 * потоку: красная проверка, в которой файл ЭТОГО шага не упомянут, — чужая, шаг
 * зеленеет с пометкой. Сужение и опасение защищали от одного и того же случая двумя
 * разными механизмами; довольно одного.
 *
 * «Импорты» подключается тем же приёмом, что и «Сборка»/«Тесты» (сразу после шага, не
 * только на этапе 6) — но НЕ безусловно: строка берётся, только если сам целевой проект
 * завёл и включил её в своём `.sdlc/gates.md`. Раннер не навязывает языковую проверку всем
 * целевым проектам по умолчанию — см. тело функции и `gates/builtin/imports.ts`.
 *
 * Сигнатура больше не принимает имя файла шага: после отказа от `TEST_FILE`-сужения строки
 * набора выбираются только по `.sdlc/gates.md`, файл шага ни на что не влияет — параметр
 * остался бы неиспользуемым и вводил бы в заблуждение, что выбор гейтов всё ещё зависит от
 * того, какой файл правит шаг.
 */
/**
 * Из уже прогнанных красных строк после шага — какая идёт в `problem` карточки: первая,
 * чей текст называет файл ЭТОГО шага (`mentionsFile`), иначе первая красная вообще —
 * прежнее поведение («чужая» краснота не тормозит шаг, `StepExecutor` пометит его ✅ «вне
 * этого файла») не меняется, когда ни одна строка про файл шага. Пустой список — гейты
 * пройдены (`null`).
 *
 * Вынесена чистой функцией отдельно от прогона гейтов ради теста: раньше первая красная
 * строка обрывала проход по остальным, и «Сборка», красная по чужой причине, не давала
 * даже запуститься «Тестам» — модель ни разу не видела ошибку СВОЕГО же тестового файла,
 * пока не собирался бриф на следующую ПОПЫТКУ этапа (найдено 2026-09-25,
 * `d2-devstral-vat-rounding`: `test/vat.test.ts` не грузился три попытки подряд).
 */
export function pickStepFailure(failures: readonly StepCheck[], file: string): StepCheck | null {
  const own = failures.find((f) => f.status === 'failed' && mentionsFile(f.problem, file));
  return own ?? failures[0] ?? null;
}

export function gatesForStep(gates: GatesFile | null): GateRow[] {
  const rows: GateRow[] = [];
  const build = gates?.rows.find((r) => gateKey(r.name) === gateKey('Сборка') && r.enabled);
  if (build !== undefined) rows.push(build);
  const tests = gates?.rows.find((r) => gateKey(r.name) === gateKey('Тесты') && r.enabled);
  if (tests !== undefined) rows.push(tests);
  // «Импорты» — БЕЗ безусловности «Сборки»/«Тестов»: строка берётся, только если проект
  // сам завёл её в .sdlc/gates.md (иначе find вернёт undefined) — раннер не навязывает
  // языковую проверку всем целевым проектам, это решение проекта, не дефолт рантайма.
  // Включена здесь же, не только на этапе 6: находка «шаг ломает свой же файл» (см. выше
  // про «Тесты») касается и класса «путь импорта без расширения» — тот же капкан «чинить
  // уже нечем на следующем шаге» (docs/model-runs.md, 2026-09-10: gates/builtin/imports.ts).
  const imports = gates?.rows.find((r) => gateKey(r.name) === gateKey('Импорты') && r.enabled);
  if (imports !== undefined) rows.push(imports);
  return rows;
}

/**
 * Исполнитель этапа 5 по шагам плана. Карта шагов показывается оператору ДО старта: это
 * замена подтверждению места правки человеком (Phase 2 методологии), которого в режиме без
 * `AskHuman` нет.
 */
export function stepFillExecutor(host: StageHost, route: ResolvedRoute): StepExecutor {
  const stage = 'chunk';
  const limits = host.limits();
  const planText = readArtifact(host.paths.plan).text;
  // Шаг с файлом вне `files_to_touch` не исполняется: политика отклонит каждую запись,
  // и запрос к модели сгорел бы впустую. Явная форма шага берёт путь из карточки, и
  // тем же списком, что у политики, он сверяется здесь, а не на первом отказе.
  // Оба списка идут через ОДНУ нормализацию путей плана (`normalizePlanPath` —
  // регистр, слэши, `./`, повторённый корень), а не сравниваются как сырые строки:
  // `extractFilesToTouch` и парсер явного шага (`planSteps.ts`) — два независимых
  // парсера одного и того же текста, и без общей нормализации расхождение написания
  // одного и того же пути (регистр, `./`) молча роняло легитимный шаг в «вне плана».
  const root = host.projectRoot;
  const allowed = new Set(extractFilesToTouch(planText).map((f) => normalizePlanPath(root, f)));
  const all = planSteps(planText);
  const steps = all.filter((s) => allowed.has(normalizePlanPath(root, s.file)));
  const outside = all.filter((s) => !allowed.has(normalizePlanPath(root, s.file)));
  const warn = (message: string): void => host.emit({ type: 'warning', runId: host.id, stage, message });
  warn(
    steps.length === 0
      ? 'этап 5 по шагам: в плане не нашлось ни одного шага с файлом из files_to_touch'
      : `карта шагов этапа 5 (по одному, рантаймом; ${steps[0]!.explicit ? 'явная форма плана' : 'по files_to_touch'}): ` +
          steps.map(describeStep).join('; '),
  );
  if (outside.length > 0) {
    warn(`шаги с файлами вне files_to_touch пропущены — записи в них политика отклонит: ${outside.map(describeStep).join('; ')}`);
  }
  warn(
    'режим по шагам: промпт этапа в модель не уходит, у каждого шага свой запрос — правка промпта в панели ' +
      'на него не действует; бриф ретрая подаётся в карточку шага',
  );
  // Проверка после шага — гейты набора проекта, если они там ВКЛЮЧЕНЫ: «Сборка»
  // всегда, «Тесты» дополнительно для шага, что пишет тестовый файл (см. `gatesForStep`
  // — иначе поломка собственного теста модели видна раннеру только в конце chunk'а
  // целиком, когда чинить её намного дороже). Нет строк — проверки нет, и отчёт
  // исполнителя говорит это, а не молчит; ⏭ (среда, таймаут) — «не состоялась», а не
  // зелёный.
  const gates = host.gatesFile();
  const buildRow = gates?.rows.find((r) => gateKey(r.name) === gateKey('Сборка') && r.enabled);
  const testsRow = gates?.rows.find((r) => gateKey(r.name) === gateKey('Тесты') && r.enabled);
  const checkLabel = [buildRow?.name, testsRow?.name].filter((n): n is string => n !== undefined).join(' + ');
  return new StepExecutor({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace(stage, 'step')),
    maxResultBytes: localResultBytes(limits),
    readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
    bashTimeoutMs: limits.gateTimeoutMs,
    params: route.params,
    currency: route.providerDef.currency ?? 'USD',
    // Расчёт `max_tokens` по остатку окна (`StepExecutor.paramsFor`) — то же поле, что
    // и у `LoopExecutor`; до этой правки `stepFill`-маршруты с объявленным
    // `contextWindow` (`config/models.json`) не получали от него никакой защиты,
    // потому что этот код его не читал (code-review-all, 2026-09-11).
    ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
    stepContext: route.stepContext,
    steps,
    planText,
    humanFacts: humanFactsBlock(host.paths.clarificationReport) ?? '',
    retryBrief: host.carryForward(),
    check:
      checkLabel === ''
        ? null
        : {
            name: checkLabel,
            run: async (step) => {
              const rows = gatesForStep(gates);
              if (rows.length === 0) {
                return { status: 'skipped', note: 'для этого шага в наборе нет применимой строки гейта' };
              }
              // Все строки проходятся до конца, не только до первой красной — иначе
              // «Сборка», красная по чужой причине, не давала «Тестам» даже
              // запуститься, и модель ни разу не видела ошибку СВОЕГО же тестового
              // файла (см. `pickStepFailure`). «Строка не найдена»/`envBlocked` —
              // тоже НЕ обрывают проход: раньше немедленный `return` на этих двух
              // ветках топил уже накопленный `failures` целиком, включая реальный
              // диагноз более ранней строки (code-review-all, 2026-09-26) — тот же
              // класс потери, ради устранения которого писался весь цикл. Они лишь
              // запоминаются как «эта строка ничего не сказала» и участвуют в решении
              // только если содержательных failures не набралось вовсе.
              const failures: StepCheck[] = [];
              let unavailable: { note: string } | null = null;
              for (const row of rows) {
                const r = await runNamedGate(host, row.name);
                if (r === null) {
                  unavailable = { note: 'строка гейта не найдена при прогоне' };
                  continue;
                }
                if (r.status === '❌') {
                  const tail = (r.outputTail ?? '').trim();
                  failures.push({
                    status: 'failed',
                    problem:
                      `гейт «${r.name}» (${r.command ?? 'встроенная реализация'}, код ${r.exitCode ?? '—'}): ${r.lastLine}` +
                      (tail === '' ? '' : `\n${tail}`),
                  });
                  continue;
                }
                if (r.status === '⏭') {
                  // `envBlocked` различает «среда не дала запуститься» (раннера нет,
                  // таймаут — законный пропуск) от содержательной находки, поданной
                  // как ⏭ (например `zeroTestsCollected`: раннер отработал, но по
                  // существу ничего не проверил). Вторую нельзя молча зеленить шагом —
                  // до этой правки обе ветки уходили в один и тот же `skipped`, и
                  // `StepExecutor` красил шаг `✅` с находкой в хвосте `note`, а не в
                  // статусе (code-review-all, 2026-09-11).
                  if (r.envBlocked) {
                    unavailable = { note: r.lastLine };
                    continue;
                  }
                  failures.push({ status: 'failed', problem: `гейт «${r.name}» вернул ⏭ по содержанию, не по среде: ${r.lastLine}` });
                  continue;
                }
              }
              const picked = pickStepFailure(failures, step.file);
              if (picked !== null) return picked;
              return unavailable === null ? { status: 'ok' } : { status: 'skipped', note: unavailable.note };
            },
          },
  });
}
