/**
 * Точка входа бенчмарка.
 *
 * Сейчас реализован только сухой прогон (`--dry-run`): он готовит рабочую копию, поднимает
 * настоящий `Run` и печатает блокеры всех семи этапов, ни разу не обратившись к модели.
 * Это самый дешёвый способ поймать то, что ломает виток до всякой модели — несобранный
 * набор гейтов, несовпавшую ветку, отсутствующий эталон методологии.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { ApprovalBus, AskBus, HumanScriptError, attachOperator, emptyOperatorLog, readHumanScript } from './operator.ts';
import { createCollector } from './collector.ts';
import type { ToolRequestEvent, ToolResolvedEvent } from './collector.ts';
import { runBench } from './driver.ts';
import { buildResult, writeResult } from './result.ts';
import { OptionsError, USAGE, parseArgs, rawLogWanted, resolveTurnLimits } from './options.ts';
import type { BenchOptions } from './options.ts';
import { ControlError, buildProfile, readControl } from './profile.ts';
import { WorkspaceError, prepareWorkspace } from './workspace.ts';
import { SnapshotError, makeSnapshot, restoreSnapshot, startStageAfter, verifyRestoredBranch } from './snapshot.ts';
import { TaskError, requireTaskFiles } from './tasks.ts';
import type { TaskPaths } from './tasks.ts';
import { rawLogDisabledReason, resetRawLog } from '../../server/src/provider/rawLog.ts';
import { SEED_NONE, applySeed, probeNoSeed, probeSeed, seedById } from './seeds.ts';
import type { SeedProbe } from './seeds.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { formatProbe, probeModel, resolveProbeTarget } from '../../server/src/probe.ts';
import { contextProblemFor } from '../../server/src/provider/contextCheck.ts';
import { formatPreflight, preflightExitCode, runPreflight } from './preflight.ts';
import { runHiddenTests } from './hiddenTests.ts';
import { checkHonesty } from './honesty.ts';
import { buildReport } from './report.ts';
import { draftJournalEntry } from './journal.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(BENCH_DIR, 'results');
const SNAPSHOTS_DIR = join(BENCH_DIR, 'snapshots');
/**
 * Трассы прогона: лента событий витка. В отличие от `results/`, в git не попадают
 * (`.gitignore`) — это мегабайты транскриптов, принадлежащие машине оператора, а не
 * проекту. Нужны для двух вещей: разбор провалившегося прогона после удаления рабочей
 * копии и корпус для замеров/обучения (`docs/model-tuning.md`).
 */
const TRACES_DIR = join(BENCH_DIR, 'traces');
const CONTROL_FILE = join(BENCH_DIR, 'control.json');
const HIDDEN_TESTS_TIMEOUT_MS = 30 * 60_000;

/**
 * Пути задачи фикстуры — из реестра `tasks.ts`, а не из соглашения об именах: с несколькими
 * каталогами фикстур (`fixtures/<family>`) каталог и оба файла выводить из одного id уже
 * не выходит. Каждая задача несёт СВОЙ банк ответов человека: `denyWritesTo` одной задачи
 * может быть ровно тем файлом, который вторая обязана тронуть (обнаружено при заведении
 * `freeship` — `discounts.ts` был запрещён для `oversize` и нужен для `freeship`), общий
 * банк на все задачи здесь в принципе не годится. Проверка файлов — общая с преполётом
 * (`taskFilesProblem` в tasks.ts): отказ здесь — код 2 и причина, а не сырой ENOENT с кодом 1.
 */
function taskFiles(task: BenchOptions['task']): TaskPaths {
  return requireTaskFiles(BENCH_DIR, task);
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
  // Лимиты ходов — `resolveTurnLimits`: без `--max-turns` штатные из загруженного конфига,
  // с ним — значение ключа без поэтапных потолков. Та же функция пишет их в паспорт результата.
  const limits = resolveTurnLimits(base.runner.limits, opts);
  return {
    ...base,
    runner: {
      ...base.runner,
      // Имя оператора уходит в поля решений артефактов. «Бенчмарк» там стоит намеренно:
      // виток, подписанный автоответчиком, не должен читаться как виток, принятый человеком.
      operator: 'Бенчмарк',
      limits: {
        ...base.runner.limits,
        maxIterationsPerStage: limits.maxTurns,
        maxIterationsByStage: limits.maxIterationsByStage,
      },
    },
  };
}

async function dryRun(opts: BenchOptions): Promise<number> {
  const base = loadConfig();
  const config = benchConfig(base, opts);
  const control = readControl(CONTROL_FILE);
  const files = taskFiles(opts.task);
  const branch = branchFromTask(files.taskFile);

  const ws = await prepareWorkspace({ fixtureDir: files.fixtureDir, slug: opts.slug, branch });
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
// Преполётная проверка окна контекста вынесена в `contextProblemFor`
// (server/src/provider/contextCheck.ts) — одна функция на прогонку, пробу и
// `--preflight`; у Ollama своя ловушка окна (голый тег = 4096), и до диспетчера
// её не проверял никто.

/** Сводка одного живого прогона — вход сводки серии `--repeat`. */
interface LiveOutcome {
  code: number;
  /** Счёт скрытых тестов; `null` — до них не дошло (снимок, обрыв до chunk'а). */
  hidden: { pass: number; total: number } | null;
  durationMs: number;
  /** Сырой дамп выключился отказами записи посреди прогона — причина; `null` — не выключался. */
  rawLogDisabled: string | null;
}

interface LiveRunFlags {
  /**
   * Преполёт этого запуска прошёл — окна измеряемых маршрутов он уже сверил той же
   * `contextProblemFor`, и повторять пару HTTP-запросов на маршрут перед каждым сэмплом
   * незачем. С `--no-preflight` проверка остаётся здесь: иначе её не сделал бы никто.
   */
  contextChecked: boolean;
}

async function liveRun(opts: BenchOptions, flags: LiveRunFlags): Promise<LiveOutcome> {
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
    const restored = restoreSnapshot({
      snapshotsDir: SNAPSHOTS_DIR,
      name: opts.fromSnapshot,
      targetSlug: opts.slug,
      expectedTask: opts.task,
    });
    await verifyRestoredBranch(restored.root, restored.branch);
    wsRoot = restored.root;
    wsBranch = restored.branch;
    wsDispose = restored.dispose;
    // Старт — со следующего этапа после точки снимка: снимок «после intent» даёт дешёвый
    // замер explore, «после plan» — прежнее поведение (замер chunk). Точка хранится в
    // самом снимке, а не в ключах прогона — прогон не может её переврать.
    const nextStage = startStageAfter(restored.stoppedAfterStage);
    if (nextStage === null) {
      wsDispose();
      throw new WorkspaceError(
        `снимок «${opts.fromSnapshot}» сделан после «${restored.stoppedAfterStage}» — этапа после него нет, мерить нечего`,
      );
    }
    startStage = nextStage;
    console.log(`снимок:        ${opts.fromSnapshot} (после ${restored.stoppedAfterStage}, старт с ${nextStage})`);
    console.log(`рабочая копия: ${wsRoot}`);
    // Посев вносится ПОСЛЕ восстановления и ДО первого этапа прогона: патч попытки
    // рантайм перегенерирует из дерева сам, и посеянное приходит рецензенту тем же
    // путём, что работа исполнителя. Ошибка внесения роняет прогон — замер без
    // внесённого дефекта выглядел бы как «рецензент ничего не нашёл». Применимость посева
    // к задаче уже проверил разбор ключей, а принадлежность снимка задаче — restoreSnapshot:
    // дерево здесь гарантированно той задачи, для которой посев объявлен.
    if (opts.seed !== null && opts.seed !== SEED_NONE) {
      const seed = seedById(opts.seed);
      try {
        applySeed(wsRoot, seed);
      } catch (e) {
        wsDispose();
        throw e;
      }
      console.log(`посев:         ${seed.id} (${seed.klass}) в ${seed.file}`);
    } else if (opts.seed === SEED_NONE) {
      console.log('посев:         none — контрольный прогон, меряются ложные срабатывания');
    }
  } else {
    const ws = await prepareWorkspace({ fixtureDir: files.fixtureDir, slug: opts.slug, branch });
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

  // Окно контекста — только у измеряемых маршрутов: контрольные (обычно claude-sdk)
  // сюда не попадают, и проверять там нечего. Дёшево (пара HTTP-запросов на маршрут)
  // и дороже стоит промолчать — расхождение (LM Studio: другое загруженное окно;
  // Ollama: голый тег с 4096 или мёртвый тег) иначе всплывает посреди прогона.
  for (const stage of flags.contextChecked ? [] : built.measured) {
    const route = built.profile.routes[stage];
    const problem = await contextProblemFor(route.provider, route.model, route.contextWindow, route.providerDef.baseUrl);
    if (problem !== null) {
      console.error(`\nокно контекста (этап «${stage}»): ${problem}`);
      wsDispose();
      return { code: 2, hidden: null, durationMs: 0, rawLogDisabled: null };
    }
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
  approvalBus.onPending((p) => {
    // Событие собирается здесь вручную (как в `server/src/index.ts`), и каждое поле запроса,
    // не перенесённое сюда, коллектор не видит вовсе: без `repaired`/`decisionsLost` починка
    // стёртого поля решения была бы в отчёте невидима. `decisionsLost` читается опционально —
    // у версии гейта без поля его просто нет.
    const extra = p as typeof p & { repaired?: string; decisionsLost?: string[] };
    const event: ToolRequestEvent = {
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
      ...(extra.repaired === undefined ? {} : { repaired: extra.repaired }),
      ...(extra.decisionsLost === undefined ? {} : { decisionsLost: extra.decisionsLost }),
      createdAt: p.createdAt,
    };
    collector.emit(event);
  });
  approvalBus.onResolved((info, decision) => {
    // Признак отмены обязан дойти до коллектора: `cancelRun` резолвит запрос решением
    // `by: 'operator'`, и без него обрыв этапа считался «отказом оператора».
    const event: ToolResolvedEvent = {
      type: 'tool_resolved',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      decision,
      ...(info.cancelled ? { cancelled: true as const } : {}),
    };
    collector.emit(event);
  });
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
    // В бюджет идут только измеряемые этапы. Контрольный маршрут (haiku/sonnet/opus)
    // тратит на порядок больше локальной модели под измерением, и с общим счётом
    // умолчание `--budget 5` закрывало виток на чужие деньги: у локального провайдера
    // `costUsd === null`, то есть измеряемая модель не тратила НИЧЕГО, а прогон вставал
    // на «бюджет прогона исчерпан: $8.1476 из $5.0000» — это потратил opus на verify.
    budgetStages: new Set(built.measured),
  });
  runId = run.id;

  // Трение о человека считает ВИТОК — на стенде тем же способом, что в проде: шины лишь
  // доставляют события. Без этой подписки `metrics.human` измерительного прогона оставался
  // пустым и читался как «виток человека не ждал» при десятках решений автоответчика.
  approvalBus.onResolved((info, decision) => run.noteApprovalDecision(info, decision));
  askBus.onAnswered((info) => run.noteQuestionsAnswered(info));

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
        task: opts.task,
      });
      console.log(`\nснимок сохранён: ${opts.makeSnapshot} (после ${opts.snapshotAfter})`);
      return {
        code: 0,
        hidden: null,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        rawLogDisabled: rawLogDisabledReason(),
      };
    }

    // Щуп посева считается по уже готовым фактам прогона: красный гейт фактического
    // прогона рантайма и упоминание МЕСТА дефекта в отчёте приёмки (включая причины
    // вердикта, куда попадают находки ревью). Второго суждения здесь не появляется.
    let seedProbe: SeedProbe | null = null;
    if (opts.seed !== null) {
      const reportPath = run.ctx.paths.verificationReport(run.ctx.chunk, run.ctx.attempt);
      const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
      const verdictReasons = driverResult.finalVerdict?.reasons ?? null;
      seedProbe =
        opts.seed === SEED_NONE
          ? probeNoSeed({ verdictReasons, gateResults: run.gateResults })
          : probeSeed({ seed: seedById(opts.seed), reportText, verdictReasons, gateResults: run.gateResults });
      console.log(`посев:     ${seedProbe.note}`);
    }

    // Скрытые тесты и честность считаются здесь, пока рабочая копия ещё жива (finally
    // ниже её удалит, если не --keep-workspace) — вне liveRun им взять дерево неоткуда.
    // Порядок важен: сводки уходят в buildResult, чтобы result.json хватало для полного
    // пересбора отчёта. runHiddenTests исключений не бросает (таймаут и крах спавна
    // возвращаются errorText внутри сводки), поэтому запись результата не подвержена.
    const paths = new WitokPaths(wsRoot, opts.slug);
    // `run.chunk`, не жёсткая единица: driver мог дойти до retry и уйти на chunk 2+.
    const journalPath = paths.chunkJournal(run.chunk);
    const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
    const events = readPersistedEvents(wsRoot, opts.slug);

    // Раскладку цели здесь не угадываем (`src/index.ts` был допущением одной фикстуры):
    // если точки входа нет, скрытый тест сам упадёт с `errorText` — а «не запускались» в
    // отчёте означало бы, что проверки не было, и это неправда.
    const hasFeature = existsSync(files.hiddenFile);
    const chunkRan = driverResult.stages.some((s) => s.stage === 'chunk');
    // Потолок: скрытый тест, сам гоняющий набор цели (до 8 прогонов подряд у мигающих
    // наборов), не должен вешать бенчмарк после оплаченного прогона — зависший импорт цели
    // без потолка висел бы вечно.
    const hidden =
      hasFeature && chunkRan
        ? await runHiddenTests({ hiddenFile: files.hiddenFile, targetDir: wsRoot, timeoutMs: HIDDEN_TESTS_TIMEOUT_MS })
        : null;

    const honesty = checkHonesty({
      journalText,
      events,
      verdictReasons: driverResult.finalVerdict?.reasons ?? null,
      hiddenTests: hidden,
      operatorLog: operatorLog,
      // Оба поля — про то, ЧЬЁ поведение судит щуп: `verify` идёт контрольным маршрутом, а
      // красные скрытые тесты при незелёном вердикте — дефект кода, не ложь отчёта.
      measured: built.measured,
      // Именно `driverResult`, а не `result`: тот объявлен ниже (`const`), и обращение сюда
      // роняло КАЖДЫЙ живой прогон в TDZ — после отработавшего витка и скрытых тестов, но
      // до `writeResult`, то есть измерение выбрасывалось целиком.
      verdictPassed: driverResult.finalVerdict?.passed ?? null,
    });

    const result = buildResult({
      opts,
      built,
      startedAt,
      finishedAt,
      driver: driverResult,
      metrics: run.metrics,
      operator: operatorLog,
      observed: collector.state,
      ...(seedProbe === null ? {} : { seed: seedProbe }),
      hidden,
      honesty,
      turnLimits: resolveTurnLimits(base.runner.limits, opts),
    });

    const resultPath = join(RESULTS_DIR, `${opts.slug}.json`);
    writeResult(resultPath, result);
    console.log(`\nостановка: ${driverResult.stopped}`);
    console.log(`вердикт:   ${driverResult.finalVerdict === null ? '—' : JSON.stringify(driverResult.finalVerdict)}`);
    console.log(`результат: ${resultPath}`);

    // Щуп посева считается по уже готовым фактам прогона: красный гейт рантайма и
    // упоминание МЕСТА дефекта в отчёте приёмки. Второго суждения здесь нет.
    // Всё, что нужно отчёту, уже лежит в `result` — второго набора тех же фактов рядом нет.
    const report = buildReport({ result });
    const reportPath = join(RESULTS_DIR, `${opts.slug}.report.md`);
    writeFileSync(reportPath, `${report.markdown}\n`, 'utf8');
    console.log(`отчёт:     ${reportPath}${report.dangerous ? '  ⚠️ ОПАСНА' : ''}`);

    // Лента событий живёт в рабочей копии и умирает вместе с ней (`finally` ниже), а без
    // неё после прогона нельзя ни разобрать провал, ни собрать корпус: `results/*.json`
    // хранит имена инструментов и ДЛИНЫ промптов, но не тексты. Копируется всегда —
    // сырой дамп запросов (`SDLC_RAW_LOG_DIR`) лежит уже вне копии и переноса не требует.
    try {
      const traceDir = join(TRACES_DIR, opts.slug);
      mkdirSync(traceDir, { recursive: true });
      copyFileSync(paths.events, join(traceDir, 'events.ndjson'));
      console.log(`трассы:    ${traceDir}`);
    } catch (e) {
      // Прогон уже оплачен и отчёт уже написан: отказ копирования называем, но не роняем им
      // результат.
      console.log(`трассы:    не сохранены — ${e instanceof Error ? e.message : String(e)}`);
    }

    console.log('\n--- черновик docs/model-runs.md (вклеить руками) ---\n');
    console.log(draftJournalEntry({ result, report }));

    const rawLogDisabled = rawLogDisabledReason();
    if (rawLogDisabled !== null) console.log(`\nсырой дамп: ${rawLogDisabled} — корпус этого прогона неполный`);

    return {
      code: report.exitCode,
      hidden: hidden === null ? null : { pass: hidden.pass, total: hidden.total },
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      rawLogDisabled,
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
  // Та же функция, что у ручки сервера: обвязка пробы существует в одном месте, иначе
  // вердикт зависит от того, откуда её запустили.
  const target = resolveProbeTarget(config.models, opts.model);
  if ('error' in target) {
    console.error(target.error);
    return 2;
  }
  const { def, providerDef } = target;
  const contextProblem = await contextProblemFor(def.provider, def.model, def.contextWindow, providerDef.baseUrl);
  if (contextProblem !== null) {
    console.error(`окно контекста: ${contextProblem}`);
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

/**
 * Преполётный тест (`preflight.ts`): среда + расширенная проба модели, без рабочей
 * копии и без витка. Используется и режимом `--preflight`, и автогейтом перед живым
 * прогоном — код возврата в обоих местах считает одна функция, чтобы вердикт не
 * зависел от того, откуда преполёт запустили.
 */
async function preflightRun(opts: BenchOptions): Promise<number> {
  const report = await runPreflight(opts);
  console.log(formatPreflight(report));
  return preflightExitCode(report);
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
  | { slug: string; error: string; rawLogDisabled: string | null };

async function seriesRun(opts: BenchOptions, flags: LiveRunFlags): Promise<number> {
  const outcomes: SeriesSample[] = [];
  for (let i = 1; i <= opts.repeat; i++) {
    const slug = `${opts.slug}-s${i}`;
    console.log(`\n===== серия: сэмпл ${i} из ${opts.repeat} (${slug}) =====\n`);
    // Выключение дампа после трёх отказов записи действует на процесс, а сэмплы серии идут в
    // одном процессе: без сброса икота первого сэмпла молча гасила корпус всех остальных.
    resetRawLog();
    // Исключение одного сэмпла не выбрасывает уже отгонянные платные сэмплы: сводка
    // серии обязана напечататься по измеренному, а упавший — лечь строкой «не измерен».
    // КОНФИГУРАЦИОННЫЕ ошибки — исключение из исключения: они одинаковы для всех сэмплов,
    // и глотать их значило бы готовить и рушить repeat рабочих копий одной и той же
    // ошибкой без заголовка «профиль не собрался» (ревью-2) — пробрасываются в main.
    try {
      const outcome = await liveRun({ ...opts, slug }, flags);
      outcomes.push({ ...outcome, slug });
    } catch (e) {
      if (
        e instanceof ProfileError ||
        e instanceof ControlError ||
        e instanceof WorkspaceError ||
        e instanceof HumanScriptError ||
        e instanceof TaskError ||
        e instanceof SnapshotError
      ) {
        throw e;
      }
      const msg = (e as Error).message;
      console.error(`сэмпл ${slug} не измерен: ${msg}`);
      outcomes.push({ slug, error: msg, rawLogDisabled: rawLogDisabledReason() });
    }
  }

  console.log(`\n===== сводка серии (${opts.repeat} сэмплов) =====`);
  for (const o of outcomes) {
    const rawLog = o.rawLogDisabled === null ? '' : ` · сырой дамп ${o.rawLogDisabled}`;
    if (o.error !== undefined) {
      console.log(`  ${o.slug}: НЕ ИЗМЕРЕН — ${o.error}${rawLog}`);
      continue;
    }
    const mins = (o.durationMs / 60_000).toFixed(1);
    const probes = o.hidden === null ? 'щупы не гонялись' : `щупы ${o.hidden.pass}/${o.hidden.total}`;
    console.log(`  ${o.slug}: код ${o.code} · ${probes} · ${mins} мин${rawLog}`);
  }
  const measuredSamples = outcomes.filter((o): o is LiveOutcome & { slug: string } => o.error === undefined);
  const withHidden = measuredSamples.filter((o) => o.hidden !== null);
  if (withHidden.length > 0) {
    const passes = withHidden.map((o) => o.hidden!.pass);
    // Знаменатель — не «у первого сэмпла»: `total` без пропущенных кейсов и 0 при крахе
    // импорта, то есть от сэмпла к сэмплу может отличаться. Берётся наибольший, а
    // расхождение называется — иначе «медиана 7/0» при упавшем первом сэмпле.
    const totals = withHidden.map((o) => o.hidden!.total);
    const total = Math.max(...totals);
    const uneven = new Set(totals).size > 1 ? ` (знаменатель по сэмплам: ${totals.join(', ')})` : '';
    console.log(
      `  щупы: медиана ${median(passes)}/${total}${uneven}, разброс ${Math.min(...passes)}–${Math.max(...passes)}` +
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
  // худший исход, как везде в вердиктах. Через measuredSamples, а не магический фильтр
  // «code !== 2»: измеренный сэмпл с легитимным кодом 2 не должен выпадать из агрегации.
  const codes = measuredSamples.map((o) => o.code);
  return codes.length === 0 ? 2 : Math.max(...codes);
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

  // Сырой дамп — для ЛЮБОГО живого прогона, не только серии: одиночный прогон без него
  // оставлял провал без корпуса ровно тогда, когда его хотелось разобрать (по серии v4 нельзя
  // было восстановить, что модель написала, упёршись в лимит длины). `provider/rawLog.ts`
  // читает переменную при первой записанной паре; проба преполёта идёт без метки `trace` и
  // пар не пишет, поэтому важен лишь порядок «до первого этапа витка» — он здесь соблюдён.
  if (rawLogWanted(opts, process.env['SDLC_RAW_LOG_DIR'])) {
    process.env['SDLC_RAW_LOG_DIR'] = join(TRACES_DIR, 'raw');
    console.log(`сырой дамп запросов: ${process.env['SDLC_RAW_LOG_DIR']} (отключить: --no-raw-log)`);
  }

  try {
    if (opts.probe) return await probeRun(opts);
    if (opts.dryRun) return await dryRun(opts);
    if (opts.preflightOnly) return await preflightRun(opts);
    // Автогейт: долгий прогон (и серия, и съёмка снимка — она платная) не стартует на
    // красном преполёте. Один преполёт на серию `--repeat`, не на сэмпл: среда и модель
    // между сэмплами одни и те же. Отключается осознанным `--no-preflight`.
    let contextChecked = false;
    if (opts.preflight) {
      const gateCode = await preflightRun(opts);
      if (gateCode !== 0) {
        console.error(`\nпреполёт красный (код ${gateCode}) — прогон не начат. Осознанный запуск на красном: --no-preflight`);
        return gateCode;
      }
      contextChecked = true;
      console.log('');
    }
    if (opts.repeat > 1) return await seriesRun(opts, { contextChecked });
    return (await liveRun(opts, { contextChecked })).code;
  } catch (e) {
    // Три причины «измерение не состоялось» называются отдельно: у каждой свой способ
    // починки, и слив их в один текст стоил бы времени на следующем прогоне.
    if (e instanceof ProfileError) {
      console.error(`профиль не собрался:\n  ${e.problems.join('\n  ')}`);
      return 2;
    }
    if (
      e instanceof ControlError ||
      e instanceof WorkspaceError ||
      e instanceof HumanScriptError ||
      e instanceof TaskError ||
      e instanceof SnapshotError
    ) {
      console.error(`подготовка не удалась: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
