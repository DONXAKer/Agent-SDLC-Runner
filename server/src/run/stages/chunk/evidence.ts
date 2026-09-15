/**
 * Этап 5: улики попытки — база грязного дерева, патч, тесты и Scope-гейты из фактов, а не
 * из слов исполнителя; и сравнение патчей соседних попыток для детекта «нет прогресса».
 */

import type { GateRunResult } from '@sdlc-runner/shared';

import { readArtifact, writeArtifact } from '../../../artifacts/artifact.ts';
import type { WitokPaths } from '../../../artifacts/paths.ts';
import { snapshotBaseline } from '../../../gates/builtin/index.ts';
import type { BuiltinGate, GateContext } from '../../../gates/builtin/index.ts';
import { stageNewPlanFiles } from '../../../gates/git.ts';
import { runGateByName } from '../../../gates/run.ts';
import { ensureSandboxFor } from '../../../sandbox/registry.ts';
import { diffCloseness } from '../../diffDistance.ts';
import { recordAttemptEvidence } from '../../evidence.ts';
import type { TreeChange } from '../../evidence.ts';
import { planConstantsMissingFromDiff } from '../../planConstants.ts';
import type { StageHost } from '../types.ts';

export function readBaseline(host: StageHost): ReadonlyMap<string, string> | null {
  const a = readArtifact(host.paths.chunkBaseline(host.chunk()));
  if (!a.exists) return null;
  try {
    return new Map(Object.entries(JSON.parse(a.text) as Record<string, string>));
  } catch {
    return null;
  }
}

/**
 * Снимок грязного дерева перед первой попыткой chunk'а.
 *
 * Без него scope-гейт вменяет исполнителю чужие незакоммиченные правки оператора.
 * Снимается один раз на chunk: на второй попытке дерево уже содержит работу агента,
 * и пересъёмка стёрла бы ровно то, что гейт должен увидеть.
 */
export async function ensureBaseline(host: StageHost): Promise<void> {
  const path = host.paths.chunkBaseline(host.chunk());
  if (readArtifact(path).exists) return;
  const snapshot = await snapshotBaseline(host.projectRoot);
  writeArtifact(path, JSON.stringify(snapshot, null, 2));

  // Грязное дерево называется человеку. Методология (этап 5): «дерево грязное чужими
  // правками — назови их человеку одной строкой… молча продолжать нельзя, эти файлы
  // попадут в diff попытки и в гейт „Scope: файлы вне плана“ как твоя работа». База
  // отличит чужое от своего, но оператор должен знать, что она вообще понадобилась.
  const dirty = Object.keys(snapshot);
  if (dirty.length === 0) return;
  const shown = dirty.slice(0, 5).join(', ');
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'chunk',
    message:
      `дерево грязное до начала chunk'а: ${dirty.length} файл(ов) — ${shown}` +
      `${dirty.length > 5 ? ` и ещё ${dirty.length - 5}` : ''}. Их правки в diff попытки ` +
      `не войдут: база chunk ${host.chunk()} записана. Решение — чинить дерево или ` +
      `продолжать с базой — за вами.`,
  });
}

/**
 * Один гейт набора проекта по имени — тем же путём, что прогон всех гейтов
 * (`runGateByName`: команда в обратных кавычках имеет приоритет). `null` — строки
 * нет или она выключена. Нужен проверке после шага в режиме `stepFill` и улике тестов.
 *
 * Песочница греется здесь же: `runGateByName` этого не делает (только `runGates`), и
 * первая «Сборка» после шага при старте с chunk шла на хосте — «нет tsc» читалось как
 * ⏭ и зелёный шаг, а иная версия инструмента давала ложный красный.
 */
/**
 * `ctx` — переиспользовать уже построенный `GateContext` вызывающего (`recordEvidence`),
 * а не строить свой. Раньше строился всегда свой: два новых вызова для улики
 * (`Scope: файлы вне плана`/`Scope: пути плана без правок`) получали контекст с ДРУГОЙ
 * идентичностью объекта, чем `gateCtx` соседних `recordAttemptEvidence`/`runTests` — а
 * WeakMap-кэши гейтов (`gates/builtin/index.ts`: `modulesCache`, `diffCache`,
 * `rawDiffCache`) ключуются именно по идентичности `ctx`, так что кэш никогда не
 * подхватывался, вопреки соседнему комментарию, который это утверждал (code-review-all,
 * 2026-09-14).
 */
export async function runNamedGate(host: StageHost, name: string, ctx?: GateContext): Promise<GateRunResult | null> {
  const gates = host.gatesFile();
  if (gates === null) return null;
  const modules = host.projectModules();
  try {
    await ensureSandboxFor(host.projectRoot, host.projectName);
  } catch (e) {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'chunk',
      message: `песочница для гейта «${name}» не поднялась: ${(e as Error).message}`,
    });
  }
  const signal = host.aborterSignal();
  const gateCtx: GateContext =
    ctx ?? {
      projectRoot: host.projectRoot,
      planFiles: host.planFilesFor('chunk') ?? [],
      baseline: readBaseline(host),
      timeoutMs: host.limits().gateTimeoutMs,
      ...(modules === undefined ? {} : { modules }),
      ...(signal === undefined ? {} : { signal }),
    };
  return runGateByName(
    name,
    {
      gates,
      projectRoot: host.projectRoot,
      projectName: host.projectName,
      planFiles: gateCtx.planFiles,
      baseline: gateCtx.baseline,
      timeoutMs: gateCtx.timeoutMs,
      ...(modules === undefined ? {} : { modules }),
      ...(signal === undefined ? {} : { signal }),
    },
    gateCtx,
  );
}

/**
 * Патч и запись о тестах этой попытки — из фактов, а не из слов исполнителя.
 *
 * Тесты гоняются ТОЙ ЖЕ строкой набора, что и на этапе 6, через `runGateByName`: два
 * способа «запустить тесты проекта» расходятся молча, и они уже разошлись — проект с
 * `./gradlew test` в наборе получал в улике результат встроенного автодетекта.
 *
 * Возвращает, что стало с деревом. `unknown` — посчитать не удалось; вызывающий обязан
 * обойтись с этим как с провалом, а не как с «правки были».
 */
export async function recordEvidence(host: StageHost, diffBefore: string): Promise<TreeChange> {
  const modules = host.projectModules();
  const aborterSignal = host.aborterSignal();
  const gateCtx: GateContext = {
    projectRoot: host.projectRoot,
    planFiles: host.planFilesFor('chunk') ?? [],
    baseline: readBaseline(host),
    timeoutMs: host.limits().gateTimeoutMs,
    ...(modules === undefined ? {} : { modules }),
    ...(aborterSignal === undefined ? {} : { signal: aborterSignal }),
  };

  // Гейт «Тесты» берётся из НАБОРА проекта, а не из реестра встроенных: приоритет
  // команды в обратных кавычках — правило `runOne`, и улика обязана его соблюдать.
  const gates = host.gatesFile();
  // Один путь запуска гейта по имени на улику и на проверку после шага: второй набор
  // тех же полей контекста разошёлся бы с первым при следующем добавленном поле.
  const runTests: BuiltinGate | null =
    gates === null
      ? null
      : async () => {
          const r = await runNamedGate(host, 'Тесты');
          if (r === null) {
            return {
              status: '⏭',
              command: null,
              exitCode: null,
              lastLine: 'строки «Тесты» в наборе нет или она выключена — прогон не назначен',
            };
          }
          return {
            status: r.status,
            command: r.command,
            exitCode: r.exitCode,
            lastLine: r.lastLine,
            envBlocked: r.envBlocked,
            // Хвост вывода обязан доехать до улики: он тут ради того и посчитан.
            // Пока литерал его не переносил, «## Вывод команды» в tests.txt не
            // появлялся никогда, и попытка N+1 чинила падения вслепую.
            ...(r.outputTail === undefined ? {} : { outputTail: r.outputTail }),
          };
        };

  try {
    // Новые файлы, названные планом, заводятся в индекс рантаймом ДО записи улик:
    // право на эти пути уже выдано одобренным планом, а «забыть git add» — привычка
    // модели (2/2 наблюдения даже на контроле), не решение. Файлы вне плана не
    // трогаются — их гейт «Scope: нетракованные файлы» называет по-прежнему.
    const staged = await stageNewPlanFiles(host.projectRoot, host.planFilesFor('chunk') ?? [], host.aborterSignal());
    if (staged.added.length > 0) {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'chunk',
        message: `рантайм завёл в git новые файлы плана: ${staged.added.join(', ')}`,
      });
    }
    if (staged.problem !== null) {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'chunk',
        message: `не удалось завести файлы плана в git: ${staged.problem}`,
      });
    }

    // Улика «Тесты» идёт тем же путём, что гейт «Тесты» этапа 6, — через песочницу
    // проекта, когда она объявлена. Живой виток ta-13: у прогона, начатого сразу с
    // chunk'а, реестр песочниц пуст (его греет только runGates), и запись тестов падала
    // локальным шеллом контейнера («python3: not found», код 127) — улика краснела про
    // среду, а не про код. Сбой подготовки не роняет попытку — та же семантика, что в
    // runGates: остаёмся на локальном исполнителе.
    try {
      await ensureSandboxFor(host.projectRoot, host.projectName);
    } catch (e) {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'chunk',
        message: `песочница для улик не поднялась: ${(e as Error).message}`,
      });
    }

    const chunk = host.chunk();
    const attempt = host.attempt();
    const signal = host.aborterSignal();
    const { tree, testsNote, testsStatus, diff } = await recordAttemptEvidence({
      projectRoot: host.projectRoot,
      diffPath: host.paths.chunkDiff(chunk, attempt),
      testsPath: host.paths.chunkTests(chunk, attempt),
      diffBefore,
      gateCtx,
      runTests,
      ...(signal === undefined ? {} : { signal }),
    });

    // Улика для RunMetrics.chunkEvidence — дешёвый, безмодельный сигнал ДО дорогого
    // verify (Opus, десятки ходов): те же ДВА Scope-гейта, что этап 6 гоняет тем же
    // `gateCtx` (git diff + сверка путей с планом, без LLM). Не блокирует попытку и не
    // влияет на stage_done chunk'а — только видимость (см. комментарий в evidence.ts).
    // Разбор двух `escalate` у ministral3-14b-instruct-ctx32k (docs/model-runs.md →
    // «Серия 5×5») нашёл: рантайм уже знал «Тесты ❌»/scope-нарушение ДО старта verify,
    // но это оставалось только текстом в ленте, не структурой.
    const [scopeOutside, scopeUntouched] = await Promise.all([
      runNamedGate(host, 'Scope: файлы вне плана', gateCtx),
      runNamedGate(host, 'Scope: пути плана без правок', gateCtx),
    ]);
    host.noteChunkEvidence({
      chunk: host.chunk(),
      attempt: host.attempt(),
      testsStatus,
      treeChanged: tree === 'changed',
      scopeViolation: scopeOutside?.status === '❌' || scopeUntouched?.status === '❌',
    });

    // Пустой патч называется вслух: «этап закончился, артефакты на месте» при нетронутом
    // дереве — тот самый правдоподобный успех, ради которого улики и отобраны у агента.
    if (tree === 'empty') {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'chunk',
        message: 'дерево не изменилось за эту попытку — правки не было',
      });
    } else {
      // Тесты, написанные под собственную выдумку исполнителя, зеленеют, ничего не
      // доказывая: живой прогон (docs/model-runs.md, серия r33) поймал модель, что
      // проигнорировала явные числа плана и подставила свои. Узкая сверка — не подмена
      // ревью, просто самый дешёвый и самый прямой сигнал из всех возможных.
      const planText = readArtifact(host.paths.plan).text;
      if (planText !== '') {
        const mismatches = planConstantsMissingFromDiff(planText, diff);
        if (mismatches.length > 0) {
          host.emit({
            type: 'warning',
            runId: host.id,
            stage: 'chunk',
            message: `числа плана разошлись с diff'ом: ${mismatches.join('; ')}`,
          });
        }
      }
    }
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'chunk',
      message: `свидетельства попытки перезаписаны рантаймом · тесты: ${testsNote}`,
    });
    return tree;
  } catch (e) {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'chunk',
      message: `не удалось записать свидетельства попытки: ${(e as Error).message}`,
    });
    return 'unknown';
  }
}

/**
 * Детект отсутствия прогресса: патч текущей попытки сравнивается с патчем предыдущей.
 * Два подряд одинаковых — это остановка, а не следующая попытка.
 *
 * Сравнение дословное. «По существу» отличалось бы от «побайтово» только на шуме вроде
 * таймстампов, а угадывать, что считать шумом, здесь опаснее, чем изредка дать лишнюю
 * попытку: ложная эскалация дороже ложного продолжения.
 *
 * `closeness` — близость патча к патчу прошлой попытки; `null` — первая попытка или
 * сравнивать нечего.
 */
export function compareAttemptDiffs(
  paths: WitokPaths,
  chunk: number,
  attempt: number,
): { same: boolean; closeness: number | null } {
  // Сравниваются ТЕКУЩАЯ попытка и предыдущая. Патч текущей к моменту вердикта уже
  // существует — он обязательное предусловие этапа 6. Пока сравнивались две прошлые,
  // одинаковые попытки 1 и 2 обнаруживались только на третьей: целая итерация бюджета
  // тратилась на заведомо известный факт.
  if (attempt < 2) return { same: false, closeness: null };
  const current = readArtifact(paths.chunkDiff(chunk, attempt));
  const prev = readArtifact(paths.chunkDiff(chunk, attempt - 1));
  if (!current.exists || !prev.exists) return { same: false, closeness: null };

  // Патчи читаются один раз на вердикт и здесь же обслуживают обе меры: они бывают
  // сотнями килобайт, и второй проход по диску ради числа для интерфейса не нужен.
  return { same: current.text.trim() === prev.text.trim(), closeness: diffCloseness(prev.text, current.text) };
}
