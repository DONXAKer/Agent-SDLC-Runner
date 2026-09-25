/** Этап 4 — план витка: определение этапа и проверка `files_to_touch`. */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { NormalizedCall } from '@sdlc-runner/shared';

import { DECISION, artifactExists, hasNamedInvariants, readArtifact, readDecision, writeArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { planAxisProblems, unansweredAxes } from '../../artifacts/planAxes.ts';
import {
  addedBeyondPlanPaths,
  excludedFromPlanPaths,
  extractFilesToTouch,
  seedFilesToTouch,
  touchListEntries,
} from '../../artifacts/planFiles.ts';
import { extractExplicitSteps } from '../../artifacts/planSteps.ts';
import { applyAxisAnswers } from '../../artifacts/renderAxes.ts';
import type { ResolvedRoute } from '../../config/schema.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import { h2SectionRanges } from '../../md/table.ts';
import { ProviderEnvError } from '../../provider/ChatProvider.ts';
import { createProvider } from '../../provider/registry.ts';
import { autofillPlan, autofillReadiness } from '../formAutofill.ts';
import { fillPlanAxes } from '../planAxisFill.ts';
import { fillPlanAxesStepwise } from '../planAxisStepwise.ts';
import { explorationPathsExist } from './explore.ts';
import { claimsMinimum, hasOpenQuestions, intentFilled, intentSectionsIntact, isSmallContour, relOf } from './preconditions.ts';
import { ensureIntentSnapshot } from './intent.ts';
import type { StageContext, StageDef, StageHost, StageModule } from './types.ts';

/**
 * `files_to_touch` плана пуст — та же находка, что уже ловит `Run.blockers()` на входе в
 * `chunk` (`PlanScope выключился бы молча`), но здесь она приходит модели в её собственном
 * ходу на этапе `plan`, а не после ухода планировщика: без этой проверки виток тратил целый
 * холостой цикл — план закрывался зелёным, а бесполезность вскрывалась только на входе в
 * `chunk` (живой замер `gemma-4-e4b`/`security-bait`, 2026-09-13). Пустой список никогда не
 * легитимен в текущей архитектуре: `chunk.skipIf` отсутствует, `planScope.ts` трактует
 * пустой `files_to_touch` как «защита выключена», а не как «нечего трогать».
 *
 * Переиспользует `extractFilesToTouch` — тот же разбор секции, что и `Run.planFilesFor`
 * (второй парсер здесь завёл бы риск расхождения, см. предупреждение в `planFiles.ts`).
 */
export function filesToTouchProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  if (extractFilesToTouch(plan.text).length > 0) return null;
  return (
    `в files_to_touch плана нет ни одного пути: без него PlanScope выключится молча на ` +
    `этапе 5, и запись перестанет быть ограниченной планом. Впиши хотя бы один путь строкой ` +
    `таблицы.`
  );
}

/**
 * `files_to_touch` плана против «Что придётся тронуть» разведки (4.1): каждое расхождение
 * обязано быть объяснено строкой плана, а не молча — план вправе сузить или расширить
 * список (шаблон говорит это прямо), но не вправе разойтись с разведкой БЕЗ причины.
 *
 * Пустой список разведки не проверяется (мелкий контур, разведки не было — сверять не с
 * чем, это законно). Путь разведки, отсутствующий в `files_to_touch`, обязан быть назван в
 * «Из задачи исключено»; путь `files_to_touch`, которого нет в разведке, — в «Добавлено
 * сверх разведки». Оба скана — общим `planFiles.ts::pathsAfterLabel`, второй копии не
 * заводится.
 */
export function planTouchDiscrepancyProblem(c: StageContext): string | null {
  const intent = readArtifact(c.paths.intent);
  if (!intent.exists) return null; // отсутствие задачи ловит соседнее предусловие
  const touch = touchListEntries(intent.text).map((e) => e.path);
  if (touch.length === 0) return null;

  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  const files = extractFilesToTouch(plan.text);
  const excluded = excludedFromPlanPaths(plan.text);
  const added = addedBeyondPlanPaths(plan.text);

  const droppedSilently = touch.filter((p) => !files.includes(p) && !excluded.includes(p));
  const addedSilently = files.filter((p) => !touch.includes(p) && !added.includes(p));
  if (droppedSilently.length === 0 && addedSilently.length === 0) return null;

  const parts: string[] = [];
  if (droppedSilently.length > 0) {
    parts.push(
      `в files_to_touch нет и в «Из задачи исключено» не названы: ${droppedSilently.join(', ')}`,
    );
  }
  if (addedSilently.length > 0) {
    parts.push(
      `в files_to_touch есть, а в «Что придётся тронуть» и в «Добавлено сверх разведки» — нет: ` +
        addedSilently.join(', '),
    );
  }
  return `files_to_touch разошёлся с «Что придётся тронуть» разведки без объяснения — ${parts.join('; ')}.`;
}

/**
 * Явная форма шага (`### Шаг N`, `artifacts/planSteps.ts::extractExplicitSteps`) — со
 * строкой-образцом из шаблона (`templates/plan.template.md`), не заполненная по существу.
 *
 * Найдено серией local6 (2026-09-24): модель дважды меняла заголовок шага и поле
 * «действие», но оставляла `файл: src/tariffs.ts`, `символ: priceFor`, `закрывает:
 * claim-2, claim-4`, `проверка: node --test test/oversize.test.ts` — дословно текстом
 * образца. `src/tariffs.ts` не входил ни в `files_to_touch`, ни в проект, и явно не был
 * помечен новым — а не будь этой проверки, chunk потом читал `test/oversize.test.ts`
 * как реальный файл (`Read` на несуществующий путь, потерянные ходы).
 *
 * Проверяется только `файл`, не `проверка`: у `проверка` legит-форма почти всегда
 * называет ЕЩЁ НЕ СУЩЕСТВУЮЩИЙ тестовый файл (создаётся тем же шагом на chunk'е) —
 * проверка по этому полю дала бы находку на каждом нормальном плане. `файл` — путь,
 * который шаг РЕДАКТИРУЕТ, и он обязан быть либо уже объявлен (`files_to_touch`), либо
 * явно помечен новым, либо реально существовать; если ни то, ни другое, ни третье —
 * это чужой путь, дошедший из необновлённого образца.
 */
export function planStepSampleTextProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return null;
  const files = extractFilesToTouch(plan.text);
  for (const step of steps) {
    if (files.includes(step.file) || step.isNew) continue;
    if (existsSync(join(c.paths.projectRoot, step.file))) continue;
    return (
      `явная форма шага ${step.n} называет файл «${step.file}» — его нет ни в files_to_touch, ` +
      `ни на диске, и он не помечен новым. Похоже на нетронутую строку-образец шаблона плана ` +
      `(файл/символ/проверка скопированы из примера явной формы) — впиши настоящий путь этого ` +
      `шага или подтверди в files_to_touch.`
    );
  }
  return null;
}

/**
 * Строка набора для гейта «Разбор последствий», если он включён и отчитывается на этапе 4.
 *
 * Одно место на оба потребителя (страж этапа 4 и перенос статуса в отчёт приёмки).
 * Пока условие было выписано дважды, статус гейта решался в двух местах и в два разных
 * момента — ровно то, от чего сторожит «единственная точка решения» (ревью).
 *
 * Этап строки уважается наравне с включённостью: гейт, перенесённый проектом на другой
 * этап, отчитывается там, и требовать секцию на четвёртом значило бы держать проверку,
 * о которой набор не просил.
 */
export function axesGateRow(gates: GatesFile | null): { name: string } | null {
  if (gates === null) return null;
  const row = gates.rows.find(
    (r) => gateKey(r.name) === gateKey('Разбор последствий') && r.enabled,
  );
  if (row === undefined || row.reportsAt !== 'этап 4') return null;
  return row;
}

/**
 * Проблемы разбора последствий (гейт «Разбор последствий», этап 4).
 *
 * Гейт выключен — проверять нечего: строка набора и есть решение проекта о том, ведётся
 * ли разбор. Пустой массив у включённого гейта означает «разбор доведён», а не «оси не
 * затронуты»: второе записывается исходом «н/п» с причиной, и это тоже решение.
 */
export function axisProblems(host: StageHost): string[] {
  const gates = host.gatesFile();
  if (gates === null || axesGateRow(gates) === null) return [];
  const plan = readArtifact(host.paths.plan);
  // Пустой массив означает «разбор доведён», поэтому отсутствие артефакта им быть не
  // может: молчание тут зеленило гейт по несуществующему плану.
  if (!plan.exists) return [`${host.paths.plan} не прочитан — разбор последствий проверять не по чему`];
  // Адресат исхода проверяется по РЕАЛЬНЫМ артефактам витка, иначе «claim-99» и
  // «гейт „Такого нет“» закрывают разбор за один ход (ревью).
  const intent = readArtifact(host.paths.intent);
  // Без задачи проверяются только имена гейтов — три адресата из четырёх не проверяются
  // вовсе, и гейт проходится словарём. Это отказ проверки, а не её зелёный исход.
  if (!intent.exists) {
    return [`${host.paths.intent} не прочитан — адресатов исходов проверять не по чему`];
  }
  // Пункты берём готовым `intentClaimLines()` — тем же разбором, которым живут выжимка
  // ретрая и добор клеймов: вторая копия «пробегись по строкам задачи» разошлась бы с
  // первой при первой же правке формы листа. Текст задачи ему передаётся, чтобы файл
  // не читался вторым разом внутри той же функции.
  const claimIds = [...host.intentClaimLines(intent.text).keys()];
  return planAxisProblems(plan.text, {
    claimIds,
    hasOpenQuestion: hasOpenQuestions(intent.text),
    hasInvariants: hasNamedInvariants(intent.text),
    enabledGates: gates.rows.filter((r) => r.enabled).map((r) => r.name),
  });
}

/**
 * Топ-ап осей плана: спросить модель ОДНИМ запросом по каждой оси, о которой секция
 * «Последствия шагов» ничего не сказала — см. докстринг `run/planAxisFill.ts`.
 *
 * Оси берутся из `unansweredAxes`, а не из `axisProblems()`: та ловит и СЕМАНТИЧЕСКИ
 * неверный ответ (ссылка на несуществующий claim/гейт) — топ-ап не переписывает решение,
 * которое модель уже приняла, пусть и сославшись на несуществующий адресат; такую строку
 * `finishGuard` укажет модели как прежде, а решать её человек должен видеть сам.
 */
export async function topUpAxes(host: StageHost, route: ResolvedRoute, system: string): Promise<void> {
  if (axesGateRow(host.gatesFile()) === null) return;
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return;
  // План уже одобрен человеком (поле «Одобрение» в шапке) — топ-ап не переписывает
  // строки решения задним числом: одобрение принимается по прочитанному тексту, и
  // переписать таблицу осей после него значило бы подменить то, что человек одобрил.
  if (readDecision(plan.text, DECISION.approval).state === 'granted') return;
  const axes = unansweredAxes(plan.text);
  if (axes.length === 0) return;

  const intent = readArtifact(host.paths.intent);
  const claimIds = intent.exists ? [...host.intentClaimLines(intent.text).keys()] : [];
  const gates = host.gatesFile();
  const enabledGates = gates === null ? [] : gates.rows.filter((r) => r.enabled).map((r) => r.name);
  const exploration = readArtifact(host.paths.explorationReport);
  const axisSupportText = exploration.exists
    ? h2SectionRanges(exploration.text, /^опоры\s+осей$/i)
        .map((r) => exploration.text.slice(r.start, r.end).trim())
        .join('\n\n')
    : '';

  const limits = host.limits();
  // Форма добора — по ручке: пошаговый (одна степень свободы на вопрос) либо прежний
  // комбинированный; оба отдают один `PlanAxisFillResult` и пишутся одним путём ниже.
  const fill = route.planAxisFill === 'combined' ? fillPlanAxes : fillPlanAxesStepwise;
  const { answers, envFailure } = await fill({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('plan', 'planAxisFill')),
    model: route.model,
    params: route.params,
    system,
    axes,
    planText: plan.text,
    axisSupportText,
    claimIds,
    enabledGates,
    hasOpenQuestion: intent.exists ? hasOpenQuestions(intent.text) : false,
    hasInvariants: intent.exists ? hasNamedInvariants(intent.text) : false,
    signal: host.signal(),
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'plan', message: `топ-ап осей: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('plan', usage, route.providerDef.currency),
  });

  // Этап отменён, пока шёл добор: запрос одобрения после `Run.cancel` встал бы в уже
  // снятую очередь гейта и ждал бы человека вечно (code-review-all 2026-09-23).
  if (host.signal().aborted) return;
  if (answers.length > 0) {
    // Перечитываем план ПОСЛЕ `fillPlanAxes` — тот только что сделал долгий сетевой
    // запрос (минуты для локальных моделей), а `plan.text` снят ДО него. Строить запись
    // на устаревшей копии значило бы молча затереть ручную правку человека, внесённую,
    // пока модель отвечала (ревью) — та же причина, по которой одобрение плана тоже
    // проверяется заново, а не доверяет проверке в начале метода.
    const fresh = readArtifact(host.paths.plan);
    if (!fresh.exists || readDecision(fresh.text, DECISION.approval).state === 'granted') {
      if (envFailure !== null) throw new ProviderEnvError(envFailure);
      return;
    }
    const updated = applyAxisAnswers(fresh.text, answers);
    if (updated !== fresh.text) {
      // Запись — тем же путём, что у `applyRecords`: нормализованный `Write` через
      // политику и гейт одобрения. Второго места решения о доступе не появляется.
      const call: NormalizedCall = { kind: 'write', path: host.paths.plan, content: updated };
      const decision = await host.requestApproval({
        runId: host.id,
        stage: 'plan',
        requestId: host.syntheticRequestId('axis-fill'),
        toolName: 'Write',
        rawInput: { file_path: host.paths.plan, content: updated },
        call,
        ctx: host.policyContext('plan'),
      });
      if (decision.allowed) {
        const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
        writeArtifact(host.paths.plan, typeof edited === 'string' ? edited : updated);
        host.emit({
          type: 'warning',
          runId: host.id,
          stage: 'plan',
          message: `топ-ап осей: дописано ${answers.length} из ${axes.length}`,
        });
      }
    }
  }
  if (envFailure !== null) throw new ProviderEnvError(envFailure);
}

export const planStage: StageDef = {
  id: 'plan',
  skill: 'sdlc-plan',
  title: 'План витка',
  // `Bash` в списке нет: поле «База» пишет рантайм (`autofillPlan`, `git rev-parse HEAD`
  // мимо модели), а остальное — та же причина, что на этапе 1: план — это документ, а не
  // прогон команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
  // инструментами чтения. (Устаревший комментарий «Bash — для git rev-parse HEAD в поле
  // «База»» утверждал обратное — найдено ревью `stage-review-2026-09-18.md`, S7.)
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.plan, c.paths.readiness],
  requires: [
    {
      describe: 'отчёт разведки на месте (или мелкий контур)',
      artifact: (c) => c.paths.explorationReport,
      check: (c) =>
        isSmallContour(c) || artifactExists(c.paths.explorationReport)
          ? null
          : `нет файла ${c.paths.explorationReport}. На мелком контуре разведка не ` +
            `запускается — тогда пометь это в поле «Контур» задачи.`,
    },
    // Та же функция полноты, что у стража этапа 1 и входа в разведку (`intentFilled`): на
    // мелком контуре секцию «Что придётся тронуть» не заполняет никто, и требовать её здесь
    // значило бы блокировать план по файлу, который этап 1 честно закрыл.
    intentFilled('задача заполнена без плейсхолдеров', true),
    explorationPathsExist(),
    // И здесь тоже, не только на explore: мелкий контур пропускает разведку целиком
    // (`explore.skipIf`), и без этой строки его ветка `small ? 1 : 3` внутри проверки
    // была мертва — пустой лист доезжал до вердикта.
    claimsMinimum(),
    // Восьмое условие вердикта проверяется и на входе этапа 4: переписанная задача не
    // должна доехать до плана, а «уточнено с одобрения» — единственный законный путь.
    intentSectionsIntact('задача не переписана внутри витка (снимок секций intent.md)'),
  ],
  // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.intent)],
  humanGate: { artifact: 'plan', label: DECISION.approval },
  skipIf: null,
};

export const planModule: StageModule = {
  def: planStage,
  formFillExecutor: true,
  leanDocTools: true,
  mechanicalJobs: (host) => {
    const date = new Date().toISOString().slice(0, 10);
    return [
      {
        path: host.paths.plan,
        fill: async (t) => {
          const head = await host.head();
          const autofilled = autofillPlan(t, {
            title: host.slug,
            explorationDone: artifactExists(host.paths.explorationReport),
            clarificationDone: artifactExists(host.paths.clarificationReport),
            base: head.sha ?? head.why,
          });
          // Засев files_to_touch (4.1, «П»-половина): модель решает по готовой строке
          // (оставить/исключить/добавить), а не составляет список с нуля. Идемпотентно —
          // см. докстринг `seedFilesToTouch`.
          const intent = readArtifact(host.paths.intent);
          const touch = intent.exists ? touchListEntries(intent.text) : [];
          const seeded = seedFilesToTouch(autofilled.text, touch);
          return { text: seeded.text, filled: autofilled.filled + seeded.seeded };
        },
      },
      { path: host.paths.readiness, fill: async (t) => autofillReadiness(t, { title: host.slug, date, run: 2 }) },
    ];
  },
  checksBranchOnEntry: true,
  begin: (host, route) => ({
    // Снимка секций задачи может не быть (виток начат до его появления или с середины по
    // снимку артефактов) — тогда он снимается здесь, с предупреждением: с этого момента
    // задача под сверкой, а что было до — не проверено.
    afterStart: async () => {
      ensureIntentSnapshot(host, 'plan');
    },

    // Новая редакция плана — новое одобрение (`SDLC.md` → «Раскладка артефактов»): прежняя
    // одобренная редакция перед перезаписью переименовывается в `plan-v‹K›.md` КАК ЕСТЬ —
    // с подписью человека под той редакцией, которую он одобрял, — а свежий `plan.md`
    // раскладывается формой с пустым полем «Одобрение». До раскладки форм: иначе
    // существующий одобренный план остался бы «планом» и правился бы поверх подписи.
    beforeSeed: async () => {
      const plan = readArtifact(host.paths.plan);
      if (!plan.exists) return;
      if (readDecision(plan.text, DECISION.approval).state !== 'granted') return;
      let k = 1;
      while (artifactExists(host.paths.planArchive(k))) k += 1;
      renameSync(host.paths.plan, host.paths.planArchive(k));
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'plan',
        message:
          `одобренная редакция плана переименована в ${host.paths.planArchive(k)} как есть; новый plan.md ` +
          'раскладывается формой — одобрение прежней редакции на него не переносится',
      });
    },

    // Топ-ап осей плана (`ModelDef.planAxisFill`): оси, о которых секция «Последствия
    // шагов» ничего не сказала, добираются узкими вопросами рантайма. До стража завершения
    // этапа — он увидит меньше проблем, если топ-ап уже закрыл часть строк.
    afterTurn: async (stagePrompt, signal) => {
      if (route.flow === 'loop' && route.planAxisFill !== false && !signal.aborted) {
        await topUpAxes(host, route, stagePrompt.system);
      }
    },

    // Разбор последствий — тем же приёмом и по той же причине, что карта разведки:
    // находка нужна модели в её собственном ходу. Предусловием этапа 5 она пришла бы
    // после ухода планировщика, а дописывать исход за него стало бы некому — кроме
    // самого исполнителя, которому решение человека не принадлежит.
    finishProblem: () => {
      // Пустой files_to_touch — раньше axisProblems: без адресов правки разбор
      // последствий по осям тоже не может ссылаться на реальные пути, но само по
      // себе отсутствие files_to_touch — более фундаментальная и более дешёвая в
      // проверке находка (см. filesToTouchProblem).
      const filesProblem = filesToTouchProblem(host.ctx());
      if (filesProblem !== null) return filesProblem;
      const touchProblem = planTouchDiscrepancyProblem(host.ctx());
      if (touchProblem !== null) return touchProblem;
      const sampleProblem = planStepSampleTextProblem(host.ctx());
      if (sampleProblem !== null) return sampleProblem;
      const problems = axisProblems(host);
      if (problems.length === 0) return null;
      return [
        'секция «Последствия шагов» плана не доведена:',
        ...problems.map((p) => `- ${p}`),
        // Подписи под принятым риском в форме НЕТ намеренно: риск принимается полем
        // «Одобрение» плана, а подписная колонка была бы вторым каналом решения,
        // которого у человека в этом файле нет. Требуя подпись, страж гнал модель
        // дописывать колонку, которой в шаблоне эталона не существует (ревью).
        'Исход — из закрытого словаря: claim-N, инвариант, гейт «имя», принятый риск ' +
          '(с причиной и сроком возврата), следующий виток либо «н/п — почему». Совет ' +
          'свободным текстом исходом не является: у него нет исполнителя.',
      ].join('\n');
    },
  }),
};
