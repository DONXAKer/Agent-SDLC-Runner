/**
 * Точка входа бенчмарка.
 *
 * Сейчас реализован только сухой прогон (`--dry-run`): он готовит рабочую копию, поднимает
 * настоящий `Run` и печатает блокеры всех семи этапов, ни разу не обратившись к модели.
 * Это самый дешёвый способ поймать то, что ломает виток до всякой модели — несобранный
 * набор гейтов, несовпавшую ветку, отсутствующий эталон методологии.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { WitokPaths } from '../../server/src/artifacts/paths.ts';
import { readPersistedEvents } from '../../server/src/eventLog.ts';

import { ApprovalGate } from '../../server/src/approval/gate.ts';
import { AskGate } from '../../server/src/approval/askGate.ts';
import { loadConfig } from '../../server/src/config/load.ts';
import { ProfileError } from '../../server/src/config/profiles.ts';
import type { LoadedConfig } from '../../server/src/config/load.ts';
import { Run } from '../../server/src/run/Run.ts';
import { ApprovalBus, AskBus, attachOperator, emptyOperatorLog, readHumanScript } from './operator.ts';
import { createCollector } from './collector.ts';
import { runBench } from './driver.ts';
import { buildResult, writeResult } from './result.ts';
import { OptionsError, USAGE, parseArgs } from './options.ts';
import type { BenchOptions } from './options.ts';
import { ControlError, buildProfile, readControl } from './profile.ts';
import { WorkspaceError, prepareWorkspace } from './workspace.ts';
import { makeSnapshot, restoreSnapshot, verifyRestoredBranch } from './snapshot.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { formatProbe, probeModel } from './probe.ts';
import { runHiddenTests } from './hiddenTests.ts';
import { checkHonesty } from './honesty.ts';
import { buildReport } from './report.ts';
import { draftJournalEntry } from './journal.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(BENCH_DIR, 'results');
const SNAPSHOTS_DIR = join(BENCH_DIR, 'snapshots');
const FIXTURE_DIR = join(BENCH_DIR, 'fixture');
const CONTROL_FILE = join(BENCH_DIR, 'control.json');

/**
 * Пути задачи фикстуры. `oversize` — первая задача, заведена до многозадачности, имена
 * файлов без суффикса; более новые задачи (`freeship`, …) — с суффиксом `-<task>`/`.<task>`.
 * Каждая задача несёт СВОЙ банк ответов человека: `denyWritesTo` одной задачи может быть
 * ровно тем файлом, который вторая обязана тронуть (обнаружено при заведении `freeship` —
 * `discounts.ts` был запрещён для `oversize` и нужен для `freeship`), общий банк на все
 * задачи здесь в принципе не годится.
 */
function taskFiles(task: BenchOptions['task']): { taskFile: string; humanFile: string; hiddenFile: string } {
  const suffix = task === 'oversize' ? '' : `-${task}`;
  return {
    taskFile: join(FIXTURE_DIR, task === 'oversize' ? 'task.md' : `task${suffix}.md`),
    humanFile: join(FIXTURE_DIR, task === 'oversize' ? 'human.json' : `human${suffix}.json`),
    hiddenFile: join(BENCH_DIR, 'checks', 'hidden', `${task}.hidden.mjs`),
  };
}

/**
 * Ветка витка берётся из текста задачи, а не из отдельной настройки.
 *
 * Задача называет ветку модели, и `intent.md` обязан её повторить; если бы имя жило в двух
 * местах, они разъехались бы, и виток встал бы на сверке ветки по нашей вине, а не по вине
 * модели.
 */
function branchFromTask(taskPath: string): string {
  const text = readFileSync(taskPath, 'utf8');
  const m = /`(sdlc\/[\w.\/-]+)`/.exec(text);
  if (m === null) throw new WorkspaceError(`${taskPath}: в тексте задачи не названа ветка витка вида \`sdlc/…\``);
  return m[1]!;
}

/** Конфиг машины с наложением того, что бенчмарк обязан задать сам. */
function benchConfig(base: LoadedConfig, opts: BenchOptions): LoadedConfig {
  return {
    ...base,
    runner: {
      ...base.runner,
      // Имя оператора уходит в поля решений артефактов. «Бенчмарк» там стоит намеренно:
      // виток, подписанный автоответчиком, не должен читаться как виток, принятый человеком.
      operator: 'Бенчмарк',
      limits: { ...base.runner.limits, maxIterationsPerStage: opts.maxIterationsPerStage },
    },
  };
}

async function dryRun(opts: BenchOptions): Promise<number> {
  const base = loadConfig();
  const config = benchConfig(base, opts);
  const control = readControl(CONTROL_FILE);
  const branch = branchFromTask(taskFiles(opts.task).taskFile);

  const ws = await prepareWorkspace({ fixtureDir: FIXTURE_DIR, slug: opts.slug, branch });
  console.log(`рабочая копия: ${ws.root}`);
  console.log(`ветка витка:   ${ws.branch} (база ${ws.baseCommit.slice(0, 8)})`);

  const built = buildProfile({
    projectRoot: ws.root,
    models: config.models,
    control,
    opts,
  });
  console.log(`профиль:       ${built.profile.label}`);
  for (const stage of STAGE_ORDER) {
    const measured = built.measured.includes(stage);
    console.log(`  ${measured ? '→' : ' '} ${stage.padEnd(8)} ${built.routes[stage]}${measured ? '   (под измерением)' : ''}`);
  }

  const events: RunEvent[] = [];
  const run = new Run({
    config,
    project: built.project,
    profile: built.profile,
    slug: opts.slug,
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: (e) => events.push(e),
  });

  console.log('\nблокеры этапов (модель не вызывалась):');
  let blockedStages = 0;
  try {
    for (const stage of STAGE_ORDER as readonly StageId[]) {
      const problems = run.blockers(stage);
      if (problems.length === 0) {
        console.log(`  ${stage.padEnd(8)} — путь свободен`);
        continue;
      }
      blockedStages += 1;
      console.log(`  ${stage.padEnd(8)} — ${problems.length}:`);
      for (const p of problems) console.log(`      ${p}`);
    }
  } finally {
    await run.dispose();
    if (opts.keepWorkspace) console.log(`\nрабочая копия оставлена: ${ws.root}`);
    else ws.dispose();
  }

  // Блокеры на поздних этапах — норма: их снимают артефакты, которых на сухом прогоне ещё
  // нет. Значим ровно один этап: до `intent` виток обязан доходить без единого блокера.
  const intentBlocked = run.blockers('intent').length > 0;
  console.log(
    intentBlocked
      ? '\nсухой прогон КРАСНЫЙ: этап 1 заблокирован — до модели дело не дойдёт'
      : `\nсухой прогон зелёный: этап 1 открыт, заблокированных этапов дальше — ${blockedStages}`,
  );
  return intentBlocked ? 2 : 0;
}

/**
 * Живой прогон (шаг 3 ROADMAP.md): готовит рабочую копию, поднимает `Run` с автоответчиком
 * человека вместо живого оператора, ведёт виток драйвером и пишет `result.json`.
 *
 * `ApprovalBus`/`AskBus` — фан-аут вокруг штатных конструкторов `ApprovalGate`/`AskGate`
 * (см. `operator.ts`): один поток событий уходит в коллектор (лента на диск + числа
 * рантайма), второй — автоответчику, который отвечает вместо человека.
 */
/** Сводка одного живого прогона — вход сводки серии `--repeat`. */
interface LiveOutcome {
  code: number;
  /** Счёт скрытых тестов; `null` — до них не дошло (снимок, обрыв до chunk'а). */
  hidden: { pass: number; total: number } | null;
  durationMs: number;
}

async function liveRun(opts: BenchOptions): Promise<LiveOutcome> {
  const base = loadConfig();
  const config = benchConfig(base, opts);
  const control = readControl(CONTROL_FILE);
  const files = taskFiles(opts.task);
  const branch = branchFromTask(files.taskFile);
  const script = readHumanScript(files.humanFile);

  // Снимок (шаг 6 ROADMAP.md) заменяет `intent → … → plan` восстановленным деревом —
  // побайтово тем же для всех моделей, которые с него стартуют. `ws*` ниже — общая форма
  // для обоих источников рабочей копии, чтобы дальше по функции путь не разветвлялся.
  let wsRoot: string;
  let wsBranch: string;
  let wsDispose: () => void;
  let startStage: StageId | undefined;

  if (opts.fromSnapshot !== null) {
    const restored = restoreSnapshot({ snapshotsDir: SNAPSHOTS_DIR, name: opts.fromSnapshot, targetSlug: opts.slug });
    await verifyRestoredBranch(restored.root, restored.branch);
    wsRoot = restored.root;
    wsBranch = restored.branch;
    wsDispose = restored.dispose;
    // Старт — со следующего этапа после точки снимка: снимок «после intent» даёт дешёвый
    // замер explore, «после plan» — прежнее поведение (замер chunk). Точка хранится в
    // самом снимке, а не в ключах прогона — прогон не может её переврать.
    const after = STAGE_ORDER.indexOf(restored.stoppedAfterStage);
    const nextStage = STAGE_ORDER[after + 1];
    if (after < 0 || nextStage === undefined) {
      wsDispose();
      throw new WorkspaceError(
        `снимок «${opts.fromSnapshot}» сделан после «${restored.stoppedAfterStage}» — этапа после него нет, мерить нечего`,
      );
    }
    startStage = nextStage;
    console.log(`снимок:        ${opts.fromSnapshot} (после ${restored.stoppedAfterStage}, старт с ${nextStage})`);
    console.log(`рабочая копия: ${wsRoot}`);
  } else {
    const ws = await prepareWorkspace({ fixtureDir: FIXTURE_DIR, slug: opts.slug, branch });
    wsRoot = ws.root;
    wsBranch = ws.branch;
    wsDispose = ws.dispose;
    console.log(`рабочая копия: ${ws.root}`);
    console.log(`ветка витка:   ${ws.branch} (база ${ws.baseCommit.slice(0, 8)})`);
  }

  const built = buildProfile({ projectRoot: wsRoot, models: config.models, control, opts });
  console.log(`профиль:       ${built.profile.label}`);
  for (const stage of STAGE_ORDER) {
    const measured = built.measured.includes(stage);
    console.log(`  ${measured ? '→' : ' '} ${stage.padEnd(8)} ${built.routes[stage]}${measured ? '   (под измерением)' : ''}`);
  }

  const approvalBus = new ApprovalBus();
  const askBus = new AskBus();
  const operatorLog = emptyOperatorLog();

  let runId = '';
  const collector = createCollector({
    projectRoot: () => wsRoot,
    slug: () => opts.slug,
  });

  // Коллектор и автоответчик — два независимых подписчика ОДНОГО и того же потока
  // событий гейта; ни один не подменяет собой другого.
  approvalBus.onPending((p) =>
    collector.emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      toolName: p.toolName,
      rawInput: p.rawInput,
      call: p.call,
      policy: p.policy,
      preview: p.preview,
      writeTargets: p.writeTargets,
      destructive: p.destructive,
      createdAt: p.createdAt,
    }),
  );
  approvalBus.onResolved((info, decision) =>
    collector.emit({ type: 'tool_resolved', runId: info.runId, stage: info.stage, requestId: info.requestId, decision }),
  );
  askBus.onPending((p) =>
    collector.emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      toolName: 'AskHuman',
      rawInput: { questions: p.questions },
      call: { kind: 'ask_human', questions: p.questions },
      policy: { ok: true },
      preview: null,
      writeTargets: null,
      destructive: null,
      createdAt: p.createdAt,
    }),
  );
  askBus.onAnswered((info, answers) =>
    collector.emit({
      type: 'tool_result',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      ok: true,
      summary: `ответы получены: ${Object.keys(answers).length}`,
      durationMs: 0,
    }),
  );

  const operatorHandle = attachOperator({
    gate: approvalBus,
    askGate: askBus,
    runId: () => runId,
    script,
    log: operatorLog,
  });

  const run = new Run({
    config,
    project: built.project,
    profile: built.profile,
    slug: opts.slug,
    gate: approvalBus.gate,
    askGate: askBus.gate,
    emit: collector.emit,
  });
  runId = run.id;

  collector.emit({ type: 'run_started', runId: run.id, slug: opts.slug, profile: built.profile.label, projectRoot: wsRoot });

  const startedAt = new Date();
  try {
    const driverResult = await runBench({
      run,
      stageTimeoutMs: opts.stageTimeoutMs,
      runTimeoutMs: opts.runTimeoutMs,
      attempts: opts.attempts,
      // Текст задачи — в промпт этапа 1: исполнитель formFill без него сочинял задачу из слага.
      requirement: readFileSync(files.taskFile, 'utf8'),
      ...(startStage === undefined ? {} : { startStage }),
      // `--make-snapshot` останавливает драйвер сразу после точки снимка (`--snapshot-after`,
      // умолчание plan) — снимок пишется НИЖЕ, из уже остановленного дерева, а не из
      // драйвера: он про виток, не про файлы снимка.
      ...(opts.makeSnapshot === null ? {} : { stopAfterStage: opts.snapshotAfter }),
    });
    const finishedAt = new Date();

    if (opts.makeSnapshot !== null && driverResult.stopped === 'snapshot-point') {
      makeSnapshot({
        workspaceRoot: wsRoot,
        snapshotsDir: SNAPSHOTS_DIR,
        name: opts.makeSnapshot,
        slug: opts.slug,
        branch: wsBranch,
        stoppedAfterStage: opts.snapshotAfter,
      });
      console.log(`\nснимок сохранён: ${opts.makeSnapshot} (после ${opts.snapshotAfter})`);
      return { code: 0, hidden: null, durationMs: finishedAt.getTime() - startedAt.getTime() };
    }

    const result = buildResult({
      opts,
      built,
      startedAt,
      finishedAt,
      driver: driverResult,
      metrics: run.metrics,
      operator: operatorLog,
      observed: collector.state,
    });

    const resultPath = join(RESULTS_DIR, `${opts.slug}.json`);
    writeResult(resultPath, result);
    console.log(`\nостановка: ${driverResult.stopped}`);
    console.log(`вердикт:   ${driverResult.finalVerdict === null ? '—' : JSON.stringify(driverResult.finalVerdict)}`);
    console.log(`результат: ${resultPath}`);

    // Отчёт (шаг 7 ROADMAP.md): скрытые тесты и честность считаются здесь, пока рабочая
    // копия ещё жива (finally ниже её удалит, если не --keep-workspace) — вне liveRun им
    // взять дерево неоткуда.
    const paths = new WitokPaths(wsRoot, opts.slug);
    // `run.chunk`, не жёсткая единица: driver мог дойти до retry и уйти на chunk 2+.
    const journalPath = paths.chunkJournal(run.chunk);
    const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
    const events = readPersistedEvents(wsRoot, opts.slug);

    const hasFeature = existsSync(files.hiddenFile) && existsSync(join(wsRoot, 'src', 'index.ts'));
    const chunkRan = driverResult.stages.some((s) => s.stage === 'chunk');
    const hidden =
      hasFeature && chunkRan ? await runHiddenTests({ hiddenFile: files.hiddenFile, targetDir: wsRoot }) : null;

    const honesty = checkHonesty({
      journalText,
      events,
      verdictReasons: result.finalVerdict?.reasons ?? null,
      hiddenTests: hidden,
      operatorLog: operatorLog,
    });

    const report = buildReport({ result, hidden, honesty });
    const reportPath = join(RESULTS_DIR, `${opts.slug}.report.md`);
    writeFileSync(reportPath, `${report.markdown}\n`, 'utf8');
    console.log(`отчёт:     ${reportPath}${report.dangerous ? '  ⚠️ ОПАСНА' : ''}`);

    console.log('\n--- черновик docs/model-runs.md (вклеить руками) ---\n');
    console.log(draftJournalEntry({ result, report }));

    return {
      code: report.exitCode,
      hidden: hidden === null ? null : { pass: hidden.pass, total: hidden.total },
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  } finally {
    operatorHandle.detach();
    await run.dispose();
    if (opts.keepWorkspace) console.log(`\nрабочая копия оставлена: ${wsRoot}`);
    else wsDispose();
  }
}

/**
 * Преполётная проба: без рабочей копии, без витка, без контрольного профиля — только
 * провайдер измеряемой модели. Коды возврата как у бенчмарка: `0` — проба пройдена,
 * `1` — модель не прошла, `2` — измерение не состоялось (модель не найдена в конфиге).
 */
async function probeRun(opts: BenchOptions): Promise<number> {
  const config = loadConfig();
  const def = config.models.models.find((m) => m.id === opts.model);
  if (def === undefined) {
    console.error(`модель «${opts.model}» не найдена в config/models.json`);
    return 2;
  }
  const providerDef = config.models.providers[def.provider];
  if (providerDef === undefined || providerDef.flow !== 'loop') {
    console.error(
      `проба меряет флоу loop; провайдер «${def.provider}» модели «${opts.model}» ` +
        (providerDef === undefined ? 'не описан в config/models.json' : `идёт флоу ${providerDef.flow}`),
    );
    return 2;
  }
  const provider = createProvider(def.provider, providerDef, config.runner.limits.chatTimeoutMs);
  const report = await probeModel({
    provider,
    model: def.model,
    // Та же конфигурация, что у этапа: без params проба мерила бы не ту модель,
    // которую потом запускают (params и заводились ради tool-calling).
    params: def.params ?? null,
    // Свой потолок на КАЖДЫЙ кейс, а не общий на пробу: медленная модель исчерпывала
    // общий сигнал первым кейсом, и остальные красились тем же приговором.
    caseTimeoutMs: opts.stageTimeoutMs,
  });
  console.log(formatProbe(report));
  // Средовой сбой — «не измерено» (2), как у всего бенчмарка, а не приговор модели.
  if (report.envBlocked && !report.passed) return 2;
  return report.passed ? 0 : 1;
}

/** Медиана уже отсортированного НЕ обязана быть — сортируем сами. Пусто — null. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Серия `--repeat N`: N одинаковых прогонов, слаги `<slug>-s1…-sN`, сводка с медианой и
 * разбросом по щупам. Правило журнала «для 8B — серии ≥3» становится механикой: дисперсия
 * сэмплов у 8B такая, что единичный прогон недоказателен (см. `docs/model-runs.md`, r8).
 */
/** Сэмпл серии: измеренный исход ЛИБО ошибка — без фиктивных нулей в полях метрик. */
type SeriesSample =
  | (LiveOutcome & { slug: string; error?: undefined })
  | { slug: string; error: string; code: 2 };

async function seriesRun(opts: BenchOptions): Promise<number> {
  const outcomes: SeriesSample[] = [];
  for (let i = 1; i <= opts.repeat; i++) {
    const slug = `${opts.slug}-s${i}`;
    console.log(`\n===== серия: сэмпл ${i} из ${opts.repeat} (${slug}) =====\n`);
    // Исключение одного сэмпла не выбрасывает уже отгонянные платные сэмплы: сводка
    // серии обязана напечататься по измеренному, а упавший — лечь строкой «не измерен».
    // КОНФИГУРАЦИОННЫЕ ошибки — исключение из исключения: они одинаковы для всех сэмплов,
    // и глотать их значило бы готовить и рушить repeat рабочих копий одной и той же
    // ошибкой без заголовка «профиль не собрался» (ревью-2) — пробрасываются в main.
    try {
      const outcome = await liveRun({ ...opts, slug });
      outcomes.push({ ...outcome, slug });
    } catch (e) {
      if (e instanceof ProfileError || e instanceof ControlError || e instanceof WorkspaceError) throw e;
      const msg = (e as Error).message;
      console.error(`сэмпл ${slug} не измерен: ${msg}`);
      outcomes.push({ slug, error: msg, code: 2 });
    }
  }

  console.log(`\n===== сводка серии (${opts.repeat} сэмплов) =====`);
  for (const o of outcomes) {
    if (o.error !== undefined) {
      console.log(`  ${o.slug}: НЕ ИЗМЕРЕН — ${o.error}`);
      continue;
    }
    const mins = (o.durationMs / 60_000).toFixed(1);
    const probes = o.hidden === null ? 'щупы не гонялись' : `щупы ${o.hidden.pass}/${o.hidden.total}`;
    console.log(`  ${o.slug}: код ${o.code} · ${probes} · ${mins} мин`);
  }
  const measuredSamples = outcomes.filter((o): o is LiveOutcome & { slug: string } => o.error === undefined);
  const withHidden = measuredSamples.filter((o) => o.hidden !== null);
  if (withHidden.length > 0) {
    const passes = withHidden.map((o) => o.hidden!.pass);
    const total = withHidden[0]!.hidden!.total;
    console.log(
      `  щупы: медиана ${median(passes)}/${total}, разброс ${Math.min(...passes)}–${Math.max(...passes)}` +
        (withHidden.length < outcomes.length ? ` (по ${withHidden.length} из ${outcomes.length} сэмплов)` : ''),
    );
  }
  const times = measuredSamples.map((o) => o.durationMs);
  if (times.length > 0) {
    console.log(
      `  время: медиана ${((median(times) ?? 0) / 60_000).toFixed(1)} мин, ` +
        `разброс ${(Math.min(...times) / 60_000).toFixed(1)}–${(Math.max(...times) / 60_000).toFixed(1)} мин`,
    );
  }

  // Код серии: «не измерено» (2) — только если не измерился НИ ОДИН сэмпл; по измеренным —
  // худший исход, как везде в вердиктах.
  const measured = outcomes.map((o) => o.code).filter((c) => c !== 2);
  return measured.length === 0 ? 2 : Math.max(...measured);
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: BenchOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof OptionsError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }

  try {
    if (opts.probe) return await probeRun(opts);
    if (opts.dryRun) return await dryRun(opts);
    if (opts.repeat > 1) return await seriesRun(opts);
    return (await liveRun(opts)).code;
  } catch (e) {
    // Три причины «измерение не состоялось» называются отдельно: у каждой свой способ
    // починки, и слив их в один текст стоил бы времени на следующем прогоне.
    if (e instanceof ProfileError) {
      console.error(`профиль не собрался:\n  ${e.problems.join('\n  ')}`);
      return 2;
    }
    if (e instanceof ControlError || e instanceof WorkspaceError) {
      console.error(`подготовка не удалась: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
