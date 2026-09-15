/**
 * Машина витка: один прогон одного этапа за раз.
 *
 * Состояние живёт на диске, в `.sdlc/<slug>/` целевого проекта, а не в памяти процесса.
 * Поэтому предусловия проверяются чтением файлов: виток переживает перезапуск сервиса,
 * а начатый в терминале скиллами `/sdlc-*` продолжается здесь и наоборот.
 */

import { randomUUID } from 'node:crypto';

import type {
  NormalizedCall,
  Decision,
  EventSink,
  ChunkEvidenceMetric,
  GateRunResult,
  McpServerInfo,
  ToolName,
  PolicyContext,
  PreparedPrompt,
  RunEvent,
  RunStatus,
  StageId,
  Usage,
  IterationSummary,
  RedCause,
  RedCauseKind,
  RunMetrics,
  Verdict,
} from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import {
  branchNameFromField,
  decisionValue,
  DecisionFormError,
  artifactExists,
  countPlaceholdersExceptDecisions,
  hasNamedInvariants,
  readArtifact,
  readField,
  setDecision,
  writeArtifact,
} from '../artifacts/artifact.ts';
import { SDLC_DIR, WitokPaths, artifactPathOf, isArtifactKey } from '../artifacts/paths.ts';
import { ARTIFACT_KEYS as ARTIFACT_KEYS_ALL, type ArtifactKey } from '@sdlc-runner/shared';
import { appendScopeExtension, extractFilesToTouch } from '../artifacts/planFiles.ts';
import { h2SectionRanges } from '../md/table.ts';
import type { AskGate } from '../approval/askGate.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import { relativizeWithin, resolveUserPath } from '../policy/paths.ts';
import type { LoadedConfig } from '../config/load.ts';
import { EMPTY_MCP, rulesForStage } from '../config/mcp.ts';
import { effectiveMode } from '../policy/mcp.ts';
import { missingNow, seedArtifacts, stillMissing, untouchedSeeds } from './seed.ts';
import { countsTowardBudget, SpentLedger } from './spentLedger.ts';
import type { McpSetup } from '../config/mcp.ts';
import { McpHub } from '../mcp/McpHub.ts';
import { imageSaver } from '../mcp/content.ts';
import { estimateTokens, selectTools } from '../mcp/select.ts';
import type { McpToolInfo } from '../mcp/types.ts';
import { cap } from '../exec/tools/index.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../config/schema.ts';
import { FormFillExecutor } from '../exec/FormFillExecutor.ts';
import { LoopExecutor } from '../exec/LoopExecutor.ts';
import { normalize } from '../exec/normalize.ts';
import { SdkExecutor } from '../exec/SdkExecutor.ts';
import { edgeExampleLines } from '../artifacts/edgeExample.ts';
import { createProvider } from '../provider/registry.ts';
import type { TraceLabel } from '../provider/rawLog.ts';
import type {
  ExecHooks,
  FrictionKind,
  McpAccess,
  StageExecutor,
  StageResult,
} from '../exec/StageExecutor.ts';
import { REVIEWER_AGENTS } from '../exec/StageExecutor.ts';
import { loadSubagents } from '../exec/subagents.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import {
  configProblems,
  gateKey,
  parseGates,
  unimplementedGates,
} from '../gates/gatesFile.ts';
import { builtinFor, describeBuild } from '../gates/builtin/index.ts';
import { currentBranch, isRepo } from '../gates/git.ts';
import { runGateByName } from '../gates/run.ts';
import { git, hasCommits, workingDiff } from '../gates/git.ts';
import { autofillClarification, autofillPlan, autofillReadiness, autofillTitle } from './formAutofill.ts';
import { claimIdOf } from '../artifacts/claims.ts';
import { salvageBlocks } from './salvage.ts';
import { preflightBlockers } from '../sandbox/preflight.ts';
import { buildRetryBrief } from '../verdict/retryBrief.ts';
import { applyAxisAnswers } from '../artifacts/renderAxes.ts';
import { fillPlanAxes } from './planAxisFill.ts';
import { intentKeywords, type Keywords } from '../explore/keywords.ts';
import { readTree } from '../explore/tree.ts';
import type { ExploreIndex } from '../explore/types.ts';
import { buildView, type BuiltView, type EcosystemLine } from '../explore/view.ts';
import { cardBudgetPerFile, fileCard, packCards } from '../explore/cards.ts';
import { INDEX_BLOCK_BYTES, renderIndexBlock } from '../explore/render.ts';
import type { AuthorClaim } from '../explore/compare.ts';
import { ExploreExecutor } from '../exec/ExploreExecutor.ts';
import { deriveClaimsBlind, intentSectionsForBlind, type BlindClaimsResult } from './claimsBlind.ts';
import { briefFromIntent, titleFromIntent } from './exploreAutofill.ts';
import { loadSubagent } from '../exec/subagents.ts';
import { appendIteration, parseIterations } from './iterationsLog.ts';
import { postmortemBlock } from './postmortem.ts';
import { metricsBlock } from './metricsReport.ts';
import { ProviderEnvError } from '../provider/ChatProvider.ts';
import { suggestEscalation } from './escalation.ts';
import type { Escalation } from './escalation.ts';
import { checkJournalClaimsVsBash } from '../verdict/honesty.ts';
import { buildPrompt } from '../prompt/build.ts';
import {
  checkPreconditions,
  explorationPathProblem,
  filesToTouchProblem,
  intentPlaceholderProblem,
  hasOpenQuestions,
  relOf,
  stageById,
  type PreconditionReport,
  type StageContext,
  type StageDef,
  stageProducing,
} from './stages.ts';
import { ChunkState, autofillJournal } from './stages/chunk/index.ts';
import { stepFillExecutor } from './stages/chunk/steps.ts';
/** Реэкспорт: тесты и прежние импорты берут выбор гейтов шага отсюда. */
export { gatesForStep } from './stages/chunk/steps.ts';
import { compareAttemptDiffs, ensureBaseline, readBaseline, recordEvidence, runNamedGate } from './stages/chunk/evidence.ts';
import { restoreAttemptFromJournal, restoreChunkFromDir } from './stages/chunk/restore.ts';
import {
  ExploreState,
  exploreFillExecutor,
  exploreIndexFor as exploreIndexOf,
  runClaimsBlind,
  usesExploreFill,
} from './stages/explore.ts';
import { profileCurrency } from './stages/handoff.ts';
import { stageModule } from './stages/index.ts';
import { axesGateRow as axesGateRowOf, axisProblems as axisProblemsOf, topUpAxes } from './stages/plan.ts';
import { autofillBranchField, branchFactBlock } from './stages/intent.ts';
import type { StageHost } from './stages/types.ts';
import { VerifyState } from './stages/verify/state.ts';
import {
  REVIEW_GATE,
  diffStillMatchesTree,
  earlyGateRows as earlyGateRowsOf,
  earlyGatesForModel,
  gateReportBlock,
  gateResultsForVerdict,
  runVerifyGates as runVerifyGatesOf,
} from './stages/verify/gates.ts';
import {
  acceptRecord,
  applyRecords,
  autofillVerification,
  evidenceHaystack,
  topUpClaims,
  verifyGaps,
} from './stages/verify/records.ts';
import { runEnsembleReviewers } from './stages/verify/ensemble.ts';
import { runReviewFill, runReviewerDirectly } from './stages/verify/reviewer.ts';
import { retryDetail, stageVerdict } from './stages/verify/verdict.ts';

export interface RunOptions {
  config: LoadedConfig;
  project: ProjectConfig;
  profile: ResolvedProfile;
  slug: string;
  gate: ApprovalGate;
  askGate: AskGate;
  emit: EventSink;
  /**
   * Этапы, расход которых копится в бюджетный гард. `undefined` — все (прод: бюджет
   * стережёт деньги проекта целиком, и чей именно этап их тратит, неважно).
   *
   * Нужно стенду. Там измеряется ОДИН этап, остальные идут контрольным маршрутом на
   * сильной модели, и её стоимость закрывала прогон бесплатной локальной модели:
   * измеряемая при `costUsd === null` не тратит ничего, а виток вставал на «бюджет
   * прогона исчерпан: $8.1476 из $5.0000» — потолок выбирал чужой рецензент на opus.
   * Это тот же принцип, что уже введён для щупов: судить измеряемую модель, а не всё,
   * что случилось в витке.
   */
  budgetStages?: ReadonlySet<StageId>;
}

export interface RunStageOptions {
  prompt?: PreparedPrompt;
  requirement?: string;
  extra?: string;
  /** Оператор объявил обрыв витка — handoff оформляется без зелёного вердикта. */
  abortHandoff?: boolean;
}

/**
 * Упал ли этап на ОФОРМЛЕНИИ, а не на смысле — то есть можно ли закрыть его дозаполнением.
 *
 * Три причины, и все три про исчерпанный бюджет, а не про содержание:
 *  - «исчерпан лимит ходов» — кончились ходы цикла;
 *  - «артефакт этапа не заполнен» — ход завершён, бланк остался с плейсхолдерами;
 *  - «лимит длины ответа» — модель выдала предельный ответ И НЕ сделала ни одного вызова
 *    инструмента (`LoopExecutor`), то есть пыталась напечатать весь бланк одним куском.
 *
 * Третья добавлена по замеру 2026-09-08 (`bench/results/axes-gptoss32k-*`, `axes-effort-*`):
 * шесть прогонов `gpt-oss-20b` рецензентом, во всех отчёт приёмки остался шаблоном — 141
 * строка, 20 плейсхолдеров, НОЛЬ упоминаний посева. Мерилась не зоркость модели, а её
 * способность напечатать длинный бланк в одном сообщении, и спасательный путь до неё не
 * доходил.
 *
 * Любой другой провал (политика, бюджет денег, отмена) сюда НЕ входит намеренно: там
 * дозаполнение закрыло бы этап, который обязан остаться красным. Само по себе попадание
 * в этот список исхода не переворачивает — решает `notDone().length === 0` на месте вызова.
 */
export function isFormattingFailure(note: string): boolean {
  // Отдельного исключения для chunk нет: «этап зациклился» рождается только застреванием
  // `FinalizeArtifact` на журнале, то есть это провал ОФОРМЛЕНИЯ. Недописанный код на chunk
  // сторожит место переворота (`finishFormArtifact`, `codeChanged`), а не классификация.
  return (
    /исчерпан лимит ходов/.test(note) ||
    /артефакт этапа не заполнен/.test(note) ||
    /лимит длины ответа/.test(note) ||
    // Обрыв посреди вызова инструмента — тот же класс: бюджет ответа кончился на
    // оформлении (длинный `Write`/`Edit` бланка), а не на смысле. Самый частый исход
    // слабой модели С tool-use — и единственный из «лимитов длины», который в список не
    // входил: дозаполнение не запускалось ровно у тех, кому нужнее всего.
    /обрезан лимитом длины/.test(note) ||
    // Антицикл (`LoopExecutor.ts`, `FINALIZE_STALL_LIMIT`) — модель трижды подряд не
    // смогла закрыть поле МНОГОСТРОЧНОЙ правкой всего документа, но per-field
    // дозаполнение (`FormFillExecutor.askField`) — другой механизм: один изолированный
    // вопрос, без риска промахнуться `old_string` по большой таблице. Рескью УЖЕ
    // запускался безусловно (`finishFormArtifact` вызывает `fillFormFields`, пока
    // остаются плейсхолдеры), но успех не засчитывался — паттерн антицикла не входил в
    // этот список, и честно закрытый дозаполнением этап оставался красным с текстом
    // застрявшего цикла. Живой замер: серия v4, 2026-09-14, `gemma-4-e4b` — 3 из 5
    // отказов серии на этой модели были именно антициклом.
    /этап зациклился/.test(note)
  );
}

/** Этапы, после которых запись ограничена одобренным планом. */
const PLAN_SCOPED_STAGES: readonly StageId[] = ['chunk', 'verify', 'handoff'];

// Урезанный набор (`ModelDef.leanTools`) действует на этапах-документах — флаг модуля этапа
// `StageModule.leanDocTools`, там же объяснение, почему не на chunk/verify/explore.
// `Write` в списке обязателен, хотя формы уже разложены и Edit'а хватает модели:
// нормализованным Write пишут РАНТАЙМОВЫЕ пути — спасение напечатанного артефакта
// (salvageFromText) и режим заполнения по полям (FormFillExecutor). Урезание сужает
// ПРАВА, и без Write оба пути отклонялись политикой ровно на тех моделях, ради
// которых включены обе ручки.
const LEAN_TOOLS: ReadonlySet<ToolName> = new Set([
  'Read',
  'Edit',
  'Write',
  'AskHuman',
  'FinalizeArtifact',
  // Не про leanTools как таковой: FillField выдаётся отдельной ручкой (compactForms), но
  // урезание не должно ОТНИМАТЬ его, если обе ручки включены одновременно — иначе состав
  // прав тихо зависел бы от порядка, в котором применяются два независимых фильтра.
  'FillField',
]);

/**
 * Потолки длины события `model_exchange`: лента пишется на диск на каждый узкий запрос, а
 * вопрос шага плана несёт план и файл целиком — разбору «что спросили и что ответили»
 * хватает начала вопроса и ответа почти целиком.
 */
const EXCHANGE_QUESTION_CHARS = 4000;
const EXCHANGE_ANSWER_CHARS = 8000;

/**
 * Отчёт независимого рецензента, прогнанного рантаймом, — блоком во вход этапа.
 *
 * Текст рецензента подаётся как ФАКТ прогона, а не как мнение, которое можно
 * переписать: ровно так же, как итоги гейтов. Отдельно сказано, что звать `Task` второй
 * раз не нужно — иначе дешёвая модель тратит ходы на повторное ревью, которое уже
 * состоялось (а анти-цикл на `Task` ×3 её же и обрывает).
 */
export function reviewerBlock(text: string): string {
  return [
    '## Отчёт независимого рецензента (прогон рантайма, этот этап)',
    '',
    'Ревью уже проведено: рецензент запущен рантаймом на отдельном маршруте, твоего рассказа',
    'о работе он не получал. Повторно звать субагента `Task` не надо — перенеси находки в',
    '§2–§5 отчёта приёмки и учти их в статусах пунктов. Своим мнением находки не отменяй:',
    'расхождение, названное рецензентом, роняет вердикт, даже если пункта приёмки на это',
    'поведение нет.',
    '',
    text,
  ].join('\n');
}

/**
 * Дописывает к промпту оператора блок фактов, которых на момент правки ещё не было.
 *
 * Повторно не подклеивает: если оператор собрал промпт после прогона гейтов, блок уже
 * внутри, и второй экземпляр только сбил бы рецензента.
 */
function withExtra(prompt: PreparedPrompt, block: string | undefined): PreparedPrompt {
  if (block === undefined || block === '' || prompt.user.includes(block)) return prompt;
  return { ...prompt, user: `${prompt.user}\n\n${block}` };
}

/** Пустая строка трения. Функция, а не константа: объект здесь мутируется на месте. */
function EMPTY_FRICTION(): {
  repeat: number;
  badJson: number;
  denied: number;
  truncated: number;
  toolCalls: number;
  reminders: number;
} {
  return { repeat: 0, badJson: 0, denied: 0, truncated: 0, toolCalls: 0, reminders: 0 };
}

export class Run {
  readonly id = randomUUID();
  readonly project: ProjectConfig;
  readonly profile: ResolvedProfile;
  readonly slug: string;
  readonly paths: WitokPaths;

  chunk = 1;
  attempt = 1;
  status: RunStatus = 'idle';
  totalUsage: Usage = emptyUsage();

  /**
   * Потраченное по валютам — источник `spentUsdBefore` для бюджетного гарда маршрутов.
   * `totalUsage.costUsd` для этого не годится: `usage.cost` приходит в валюте СВОЕГО
   * провайдера (у polza — рубли), и смешанная сумма гасила бы гард не по существу.
   */
  private readonly spent = new SpentLedger();

  private readonly config: LoadedConfig;
  private readonly gate: ApprovalGate;
  private readonly askGate: AskGate;
  private readonly emit: EventSink;
  /**
   * Вызовы инструментов ТЕКУЩЕЙ ПОПЫТКИ — лента для рантаймных сверок фактов (честность
   * журнала, `verdict/honesty.ts`). Копится обёрткой вокруг `emit` в конструкторе: второго
   * источника событий виток не имеет, и читать потом персист-ленту с диска незачем.
   *
   * Несёт и `tool_request`, и `tool_result` — не только результаты, вопреки старому
   * имени поля: `checkJournalClaimsVsBash` сверяет КОМАНДУ из `tool_request.call`
   * (`NormalizedCall`, одна форма на оба флоу), а не текст `tool_result.summary` — на
   * флоу `loop` тот несёт первую строку ВЫВОДА команды («код возврата 0»), а не саму
   * команду, и одних результатов для сверки не хватает (code-review-all, 2026-09-11).
   *
   * Обнуляется на каждой попытке. Пока лента жила на весь виток, успешный `npm test`
   * попытки K закрывал утверждение журнала попытки K+1, где тестов не запускали, — то есть
   * щуп честности давал ложный ЗЕЛЁНЫЙ ровно в том случае, ради которого заведён (ревью).
   * Заодно снимается неограниченный рост: массив рос все итерации витка и жил до `forget`.
   */
  private attemptToolEvents: RunEvent[] = [];
  /**
   * Видел ли ЭТОТ процесс попытку с начала. `false` — попытка восстановлена из журнала
   * (рестарт сервиса, продолжение витка), и ленты для сверки у процесса нет: тогда
   * «успешного вызова нет» — утверждение о памяти процесса, а не о честности исполнителя.
   */
  private attemptObservedFromStart = false;
  private aborter: AbortController | null = null;
  /**
   * Состояние этапов, живущее между вызовами: записи и вердикт попытки этапа 6, кэш индекса
   * и слепой лист разведки, дерево попытки chunk. Владелец — виток; объяснения полей — в
   * классах состояния модулей этапов (`stages/verify/state.ts`, `stages/explore.ts`,
   * `stages/chunk/index.ts`).
   */
  private readonly state = { verify: new VerifyState(), explore: new ExploreState(), chunk: new ChunkState() };

  /** Фасад витка для модулей этапов (`StageHost`) — растёт по мере переноса логики этапов. */
  private get host(): StageHost {
    return {
      id: this.id,
      slug: this.slug,
      paths: this.paths,
      projectRoot: this.project.projectRoot,
      emit: this.emit,
      writeAutofilled: (path, text, seeded) => this.writeAutofilled(path, text, seeded),
      head: () => this.head(),
      gatesFile: () => this.gatesFile,
      intentClaimLines: (intentText) => this.intentClaimLines(intentText),
      policyContext: (stage) => this.policyContext(stage),
      trace: (stage, mode) => this.trace(stage, mode),
      accountOffPathUsage: (stage, usage, currency) => this.accountOffPathUsage(stage, usage, currency),
      syntheticRequestId: (prefix) => `${prefix}-${this.salvageSeq++}`,
      requestApproval: (req) => this.gate.request(req),
      signal: () => this.aborter?.signal ?? new AbortController().signal,
      limits: () => this.config.runner.limits,
      runner: () => this.config.runner,
      ecosystemFor: (stage) => this.ecosystemFor(stage),
      axesEnabled: () => this.axesGateRow() !== null,
      exploreState: this.state.explore,
      verifyState: this.state.verify,
      projectName: this.project.name,
      projectModules: () => this.project.modules,
      planFilesFor: (stage) => this.planFilesFor(stage),
      chunk: () => this.chunk,
      attempt: () => this.attempt,
      noteChunkEvidence: (metric) => this.chunkEvidenceAgg.set(`${metric.chunk}:${metric.attempt}`, metric),
      aborterSignal: () => this.aborter?.signal,
      attemptBudget: () => this.attemptBudget,
      carryForward: () => this.carryForward,
      markReviewerRan: () => this.markReviewerRan(),
      toolsFor: (stage) => this.toolsFor(stage),
      executorFor: (stage, route) => this.executorFor(stage, route),
      mcpAccess: (stage) => this.mcpAccess(stage),
      maxTurnsFor: (stage) => this.maxTurnsFor(stage),
      readOnlyRoots: () => this.readOnlyRoots,
      maxBudgetUsd: this.project.maxBudgetUsd,
      spentBefore: (currency) => this.spent.spent(currency),
      verifyRoute: () => this.profile.routes.verify,
      ensembleRoutes: () => this.profile.ensemble.verify ?? [],
      envBlockedAttempts: () => this.envBlockedAttempts,
    };
  }
  /**
   * Выжимка причин прошлого красного, ждущая следующей попытки chunk'а.
   *
   * Живёт на chunk, а не на попытку: `resetAttemptState` обнуляет вердикт и итоги гейтов,
   * поэтому собрать её ПОСЛЕ сброса уже не из чего — она собирается до него, в
   * `nextAttempt`, и переживает сброс намеренно.
   */
  private carryForward: string | null = null;
  /**
   * Числа витка. НЕ сбрасываются в `resetAttemptState`: там обнуляется состояние попытки,
   * а метрики принадлежат витку — иначе «сколько итераций съел виток» опять станет
   * невосстановимым.
   */
  private readonly stageStats = new Map<StageId, { runs: number; usage: Usage; durationMs: number }>();
  private readonly attemptsByChunk = new Map<number, number>();

  /**
   * Трение цикла по этапам. Считается рантаймом, а не рассказывается моделью: она про
   * свои повторы и обрезанные результаты не знает, а числа отсюда — наблюдение.
   */
  private readonly friction = new Map<
    StageId,
    {
      repeat: number;
      badJson: number;
      denied: number;
      truncated: number;
      /** Сколько вызовов инструментов этап сделал ВСЕГО. Ноль — сам по себе диагноз. */
      toolCalls: number;
      /** Сколько раз страж завершения возвращал модель доделывать артефакт. */
      reminders: number;
    }
  >();

  /**
   * Гейт-агрегаты витка. Сворачиваются по одному на каждый результат прогона — история
   * витка здесь не реплицируется: те же прогоны детально видны в ленте событий.
   */
  private readonly gateAgg = new Map<
    string,
    { gate: string; runs: number; red: number; skippedWhileEnabled: number; durationMs: number }
  >();

  /**
   * Трение о человека по этапам. Копится через `recordHuman` из колбэков гейтов
   * одобрений/вопросов — глобального стейна у этого счётчика нет: виток владеет своими
   * числами, как владеет остальными метриками.
   */
  private readonly humanAgg = new Map<StageId, { questions: number; approvals: number; waitMs: number }>();

  /**
   * Последний известный счётчик незакрытых `‹…›` по артефакту (ключ — имя файла в каталоге
   * витка). Копится перехватом событий `artifact_written`: тот, кто пишет файл, уже знает
   * его счётчик, и грепить диск второй раз незачем. Запись со счётчиком 0 (решение
   * человека, журнал итераций) затирает строку — «дозаполнен».
   */
  private readonly artifactGapsByFile = new Map<string, number>();

  /**
   * Улики попытки chunk'а (`RunMetrics.chunkEvidence`) — ключ `chunk:attempt`, по записи на
   * попытку, той же формой Map-аккумулятора, что `gateAgg`/`humanAgg`. Наполняется в
   * `recordEvidence()` сразу после `recordAttemptEvidence()` и вызова Scope-гейтов — то,
   * что рантайм УЖЕ посчитал фактически, ДО дорогого `verify`.
   */
  private readonly chunkEvidenceAgg = new Map<string, ChunkEvidenceMetric>();

  /** Внешние MCP-серверы витка: набор задан конфигом проекта, соединения — ленивые. */
  private readonly mcpSetup: McpSetup;
  private readonly hub: McpHub;
  /** Набор MCP-инструментов последнего запуска этапа — для панели и для показа промпта. */
  private mcpSelected: McpToolInfo[] = [];
  /** Счётчик сохранённых картинок витка: имена файлов не должны затирать друг друга. */
  private mcpImageSeq = 0;
  /** Счётчик спасённых из текста записей: идентификатор вызова обязан быть уникальным. */
  private salvageSeq = 0;
  /**
   * Сколько попыток этого chunk'а закончились «красным из-за окружения».
   *
   * Вычитается из счётчика при сверке с бюджетом: методология требует, чтобы дефект среды
   * не занимал попытку, а хранение этого через НЕувеличение номера стоило бы перезаписи
   * улик предыдущей попытки. Сбрасывается вместе с номером на новом chunk'е.
   */
  private envBlockedAttempts = 0;
  /** Формы, разложенные под артефакты текущего этапа, — их называет промпт. */
  private seeded: string[] = [];
  /**
   * Проваленные пункты приёмки по попыткам текущего chunk'а — вход эскалации.
   * Живёт на chunk: `resetAttemptState` обнуляет состояние ПОПЫТКИ, а история попыток
   * нужна именно между ними.
   */
  private failedClaimsByAttempt: string[][] = [];
  /** История попыток для интерфейса — тот же набор фактов, что уходит в `iterations.md`. */
  private readonly iterationLog: IterationSummary[] = [];
  private verdictCount = 0;
  private redCount = 0;
  private readonly redByCause = new Map<RedCauseKind, number>();
  /** Разобранный набор гейтов: файл проекта, читать его на каждое обращение незачем. */
  private gatesCache: { mtimeMs: number; parsed: GatesFile } | null = null;
  /** Чей расход копится в бюджет (`RunOptions.budgetStages`). `null` — все этапы. */
  private readonly budgetStages: ReadonlySet<StageId> | null;

  constructor(o: RunOptions) {
    this.config = o.config;
    this.project = o.project;
    this.profile = o.profile;
    this.slug = o.slug;
    this.gate = o.gate;
    this.askGate = o.askGate;
    this.budgetStages = o.budgetStages ?? null;
    this.emit = (e) => {
      if (e.type === 'tool_result' || e.type === 'tool_request') this.attemptToolEvents.push(e);
      // `artifact_written` несёт уже посчитанный грепом `‹` счётчик плейсхолдеров —
      // пересчитывать файл вторым способом значит дать двум местам разойтись.
      if (e.type === 'artifact_written') this.noteArtifactGap(e.path, e.placeholders);
      o.emit(e);
    };
    this.paths = new WitokPaths(o.project.projectRoot, o.slug);
    this.restoreMetrics();
    this.mcpSetup = o.config.mcp.get(o.project.name) ?? EMPTY_MCP;
    this.hub = new McpHub(this.mcpSetup.servers);
    this.chunk = restoreChunkFromDir(this.paths.dir) ?? this.chunk;
    this.attempt = restoreAttemptFromJournal(this.paths.chunkJournal(this.chunk)) ?? this.attempt;
    // Журнал хранит номер ПОСЛЕДНЕЙ начатой попытки. Если вердикт по ней уже записан,
    // она закончена и отвергнута — свежий прогон продолжает со СЛЕДУЮЩЕЙ. Живой виток
    // ta-13: новый прогон восстановил K=2 и перезаписал улики уже отревьюенной попытки 2
    // уликами попытки 3 — след попытки для рецензента и таблицы попыток был затёрт.
    while (artifactExists(this.paths.verificationReport(this.chunk, this.attempt))) {
      this.attempt += 1;
    }
  }

  get ctx(): StageContext {
    return { paths: this.paths, chunk: this.chunk, attempt: this.attempt };
  }

  /**
   * Итоги последнего прогона гейтов — для интерфейса.
   *
   * Отдаётся та же таблица, по которой считается вердикт: со статусами «не скриптовых»
   * гейтов, пересчитанными по факту. Пока отдавался сырой `lastGateResults`, оператор
   * видел «⏭ Ревью независимым агентом» прямо над зелёным вердиктом — гейт, сторожащий
   * ложный зелёный, выглядел невыполненным на штатном витке.
   */
  get gateResults(): GateRunResult[] {
    return gateResultsForVerdict(this.host);
  }

  /**
   * Числа витка для интерфейса и пост-виток отчёта.
   *
   * Стоимость складывается так, чтобы `null` не превращался в ноль: `addUsage` уже
   * распространяет `null`, и маршрут без стоимости остаётся «без стоимости», а не «$0».
   */
  get metrics(): RunMetrics {
    return {
      stages: [...this.stageStats.entries()].map(([stage, v]) => ({
        stage,
        runs: v.runs,
        usage: v.usage,
        durationMs: v.durationMs,
      })),
      verdicts: { total: this.verdictCount, red: this.redCount },
      redByCause: [...this.redByCause.entries()].map(([kind, count]) => ({ kind, count })),
      attemptsByChunk: [...this.attemptsByChunk.entries()].map(([chunk, attempts]) => ({
        chunk,
        attempts,
      })),
      // Фильтра «показывать только там, где что-то случилось» здесь больше нет: этап,
      // не сделавший НИ ОДНОГО вызова инструмента, по прежнему условию не попадал в
      // метрики вовсе — то есть самый тяжёлый исход выглядел как отсутствие трения.
      friction: [...this.friction.entries()].map(([stage, v]) => ({ stage, ...v })),
      gates: [...this.gateAgg.values()],
      human: [...this.humanAgg.entries()].map(([stage, v]) => ({ stage, ...v })),
      // Только живые долги: счётчик, дозаполненный до нуля, из отчёта исчезает.
      artifactGaps: [...this.artifactGapsByFile.entries()]
        .filter(([, placeholders]) => placeholders > 0)
        .map(([artifact, placeholders]) => ({ artifact, placeholders })),
      chunkEvidence: [...this.chunkEvidenceAgg.values()],
    };
  }

  /**
   * Учитывает один результат прогона гейта в агрегатах витка.
   *
   * Фактическое правило включённости: `GateRunResult` флага включённости не несёт, но сюда
   * результат попадает только из `runVerifyGates`, который прогоняет лишь
   * `gatesRunnableAtVerify` (включённые строки «этап 6») и внешние статусы включённых
   * гейтов — то есть ⏭ по построению означает «пропущен ВКЛЮЧЁННЫЙ гейт». Проверка по
   * набору ниже — подтверждение того же факта, а не второе определение: если строка в
   * наборе между прогоном и учётом исчезла (файл правили посреди этапа 6), ⏭ честнее не
   * зачислять, чем гадать.
   */
  recordGateResult(g: GateRunResult): void {
    const agg =
      this.gateAgg.get(g.name) ??
      ({ gate: g.name, runs: 0, red: 0, skippedWhileEnabled: 0, durationMs: 0 });
    agg.runs += 1;
    agg.durationMs += g.durationMs;
    if (g.status === '❌') agg.red += 1;
    const row = this.gatesFile?.rows.find((r) => gateKey(r.name) === gateKey(g.name));
    if (g.status === '⏭' && row?.enabled === true) agg.skippedWhileEnabled += 1;
    this.gateAgg.set(g.name, agg);
  }

  /**
   * Учитывает время и объём взаимодействия этапа с человеком. Зовётся из колбэков
   * `ApprovalGate`/`AskGate` при решении оператора; автоодобрения и отказы политики сюда
   * не доходят — они человека не ждали.
   *
   * @param n сколько вопросов (`kind: 'question'`) или одобрений (`kind: 'approval'`)
   *  принесло это решение.
   */
  /**
   * Решение оператора по запросу одобрения — в трение витка.
   *
   * Что считается трением, решает ВИТОК, а не HTTP-обвязка. Пока правило жило в колбэках
   * сервера, на стенде (`bench`, свои шины поверх тех же гейтов) оно не работало вовсе:
   * `metrics.human` оставался пустым, и отчёт измерительного прогона читался как «виток
   * человека не ждал» при десятках принятых решений (ревью).
   *
   * Автоодобрения и отказы политики сюда не идут — они человека не ждали. Снятый обрывом
   * прогона запрос тоже: `cancelRun` резолвит очередь решением `by: 'operator'`, и без
   * признака отмены всё время висения записывалось как ожидание решения.
   */
  noteApprovalDecision(
    info: { runId: string; stage: StageId; createdAt: number; cancelled: boolean },
    decision: Decision,
  ): void {
    if (info.runId !== this.id) return;
    if (decision.by !== 'operator' || info.cancelled) return;
    this.recordHuman(info.stage, 'approval', decision.allowed ? 1 : 0, Date.now() - info.createdAt);
  }

  /** Ответ человека на вопросы этапа. Отменённый вопрос ответом не является. */
  noteQuestionsAnswered(info: {
    runId: string;
    stage: StageId;
    createdAt: number;
    questions: number;
    cancelled: boolean;
  }): void {
    if (info.runId !== this.id || info.cancelled) return;
    this.recordHuman(info.stage, 'question', info.questions, Date.now() - info.createdAt);
  }

  recordHuman(stage: StageId, kind: 'question' | 'approval', n: number, waitMs: number): void {
    const agg = this.humanAgg.get(stage) ?? { questions: 0, approvals: 0, waitMs: 0 };
    if (kind === 'question') agg.questions += n;
    else agg.approvals += n;
    agg.waitMs += waitMs;
    this.humanAgg.set(stage, agg);
  }

  /** Последний известный счётчик незакрытых `‹…›` артефакта. Ноль затирает строку. */
  noteArtifactGap(path: string, placeholders: number): void {
    this.artifactGapsByFile.set(basename(path), placeholders);
  }

  /**
   * Восстанавливает накопители метрик из `metrics.json` — тем же механизмом, каким
   * chunk/attempt восстанавливаются из журналов: виток переживает пересоздание `Run`.
   *
   * Разбор снисходительный: файл пишет сам рантайм, но битый или устаревший снапшот не
   * должен ломать старт витка — в худшем случае метрики начнут копиться заново. Полей,
   * которых в старом снапшоте нет (они появились позже), просто не будет.
   */
  private restoreMetrics(): void {
    const a = readArtifact(this.paths.metrics);
    if (!a.exists) return;
    let m: Partial<RunMetrics>;
    try {
      m = JSON.parse(a.text) as Partial<RunMetrics>;
    } catch {
      return;
    }
    if (m === null || typeof m !== 'object') return;
    const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    for (const s of list<RunMetrics['stages'][number]>(m.stages)) {
      if (typeof s?.stage !== 'string') continue;
      this.stageStats.set(s.stage, {
        runs: num(s.runs),
        usage: { ...emptyUsage(), ...(typeof s.usage === 'object' && s.usage !== null ? s.usage : {}) },
        durationMs: num(s.durationMs),
      });
    }
    // Расход витка восстанавливается ВМЕСТЕ с разбивкой по этапам. Пока он оставался
    // нулём, одна и та же трата показывалась двумя разными числами на одном экране
    // (шапка и вкладка «Метрики»), а бюджетный гард маршрута стартовал с нуля и разрешал
    // потратить `maxBudgetUsd` заново — то есть виток тратил вдвое больше объявленного.
    this.totalUsage = emptyUsage();
    for (const st of this.stageStats.values()) this.totalUsage = addUsage(this.totalUsage, st.usage);
    // Суммы по валютам — служебное поле снапшота, а не часть `RunMetrics`: гард сверяет
    // потраченное в валюте СВОЕГО маршрута, и складывать рубли с долларами нельзя.
    const spent = (m as { spent?: unknown }).spent;
    if (typeof spent === 'object' && spent !== null) this.spent.restore(spent as Record<string, unknown>);
    this.verdictCount = num(m.verdicts?.total);
    this.redCount = num(m.verdicts?.red);
    this.redByCause.clear();
    for (const c of list<RunMetrics['redByCause'][number]>(m.redByCause)) {
      if (typeof c?.kind !== 'string') continue;
      this.redByCause.set(c.kind as RedCauseKind, num(c.count));
    }
    this.attemptsByChunk.clear();
    for (const c of list<RunMetrics['attemptsByChunk'][number]>(m.attemptsByChunk)) {
      if (typeof c?.chunk !== 'number') continue;
      this.attemptsByChunk.set(c.chunk, num(c.attempts));
    }
    this.friction.clear();
    for (const f of list<RunMetrics['friction'][number]>(m.friction)) {
      if (typeof f?.stage !== 'string') continue;
      this.friction.set(f.stage, { ...EMPTY_FRICTION(), ...f });
    }
    this.gateAgg.clear();
    for (const g of list<RunMetrics['gates'][number]>(m.gates)) {
      if (typeof g?.gate !== 'string') continue;
      this.gateAgg.set(g.gate, {
        gate: g.gate,
        runs: num(g.runs),
        red: num(g.red),
        skippedWhileEnabled: num(g.skippedWhileEnabled),
        durationMs: num(g.durationMs),
      });
    }
    this.humanAgg.clear();
    for (const h of list<RunMetrics['human'][number]>(m.human)) {
      if (typeof h?.stage !== 'string') continue;
      this.humanAgg.set(h.stage, {
        questions: num(h.questions),
        approvals: num(h.approvals),
        waitMs: num(h.waitMs),
      });
    }
    this.artifactGapsByFile.clear();
    for (const g of list<RunMetrics['artifactGaps'][number]>(m.artifactGaps)) {
      if (typeof g?.artifact !== 'string') continue;
      this.artifactGapsByFile.set(g.artifact, num(g.placeholders));
    }
    this.chunkEvidenceAgg.clear();
    for (const e of list<ChunkEvidenceMetric>(m.chunkEvidence)) {
      if (typeof e?.chunk !== 'number' || typeof e?.attempt !== 'number') continue;
      this.chunkEvidenceAgg.set(`${e.chunk}:${e.attempt}`, {
        chunk: e.chunk,
        attempt: e.attempt,
        testsStatus: e.testsStatus === '✅' || e.testsStatus === '❌' || e.testsStatus === '⏭' ? e.testsStatus : '⏭',
        treeChanged: e.treeChanged === true,
        scopeViolation: e.scopeViolation === true,
      });
    }
  }

  /**
   * Пишет персистентный снапшот метрик после каждого этапа: `metrics.json` (полный снапшот,
   * источник для восстановления при пересоздании витка) и `metrics.md` (рендер из того же
   * снапшота). Служебные файлы рантайма, не артефакты методологии: событие
   * `artifact_written` для них не эмитится, под формы не подпадают.
   *
   * Ошибка записи не роняет этап: метрики — наблюдаемость, а не условие корректности.
   */
  private writeMetricsSnapshot(): void {
    try {
      // `spent` — служебное поле снимка рядом с `RunMetrics`: по нему восстанавливается
      // бюджетный гард, а в контракт API суммы по валютам не входят.
      writeArtifact(
        this.paths.metrics,
        JSON.stringify({ ...this.metrics, spent: this.spent.snapshot() }, null, 2),
      );
      // Расход по этапам и трение цикла рисует `postmortemBlock` — тот же рендер, что
      // уходит в `handoff.md`. Без него файл, названный «Метрики витка», показывал
      // человеку только гейты и ожидание, а числа расхода жили лишь в конце витка.
      const currency = this.profile.routes.chunk?.providerDef.currency ?? 'USD';
      const blocks = [postmortemBlock(this.metrics, currency), metricsBlock(this.metrics)].filter(
        (b): b is string => b !== null,
      );
      if (blocks.length > 0) writeArtifact(this.paths.metricsReport, `${blocks.join('\n\n')}\n`);
    } catch (e) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: null,
        message: `метрики витка не записаны: ${(e as Error).message}`,
      });
    }
  }

  /**
   * История попыток витка — ИЗ ФАЙЛА на диске, а не из памяти процесса.
   *
   * Накопитель в памяти был вторым описанием той же истории и гарантированно расходился с
   * файлом: номер попытки виток восстанавливает с диска, а историю не восстанавливал, и
   * после перезапуска сервиса страница показывала «попытка 3» над пустой панелью, хотя
   * `iterations.md` содержал все три строки. Одна истина — файл; память остаётся только
   * запасным вариантом на случай, когда записать журнал не удалось.
   */
  get iterations(): IterationSummary[] {
    const a = readArtifact(this.paths.iterations);
    if (!a.exists) return [...this.iterationLog];
    const fromDisk = parseIterations(a.text);
    return fromDisk.length >= this.iterationLog.length ? fromDisk : [...this.iterationLog];
  }

  /** Прогон гейтов оборван отменой: набор в `gateResults` неполон. */
  get gatesAborted(): boolean {
    return this.state.verify.lastGatesAborted;
  }

  get lastVerdict(): Verdict | null {
    return this.state.verify.verdict;
  }

  /**
   * Дописывает строку в журнал итераций витка.
   *
   * Дописыванием, а не перезаписью: попытки в этом коде не перезаписываются нигде — по той
   * же причине, по которой не перезаписываются их патчи. Ошибка записи журнала не должна
   * ронять этап: журнал — наблюдаемость, а не условие корректности.
   */
  private recordIteration(verdict: Verdict, noProgress: boolean): void {
    try {
      const patch = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt));
      const existing = readArtifact(this.paths.iterations);
      const text = appendIteration(existing.exists ? existing.text : '', {
        chunk: this.chunk,
        attempt: this.attempt,
        verdict,
        gates: gateResultsForVerdict(this.host),
        patch: patch.exists ? patch.text : '',
        closeness: this.state.verify.closeness,
        // Флагом, а не грепом по тексту причины: формулировка в `verdict.ts` — текст для
        // человека, и любая её правка (перенос слова, «diff» → «патч») молча выключала бы
        // признак топтания в журнале. Ровно от этого написан соседний `classify.ts`.
        noProgress,
        at: new Date(),
      });
      writeArtifact(this.paths.iterations, text);
      this.iterationLog.push({
        chunk: this.chunk,
        attempt: this.attempt,
        passed: verdict.passed,
        action: verdict.action,
        reasons: verdict.reasons,
        closeness: this.state.verify.closeness,
        at: new Date().toISOString(),
      });
      this.emit({
        type: 'artifact_written',
        runId: this.id,
        stage: 'verify',
        path: this.paths.iterations,
        placeholders: 0,
      });
    } catch (e) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: 'verify',
        message: `журнал итераций не записан: ${(e as Error).message}`,
      });
    }
  }

  /**
   * Предложение поднять модель chunk'а. Предложение, а не переход: смена модели посреди
   * витка меняет стоимость и поведение, и решает это человек.
   */
  get escalation(): Escalation {
    // КРАЙНИЕ значения ансамбля, ровно как в `checkReviewerRule`: сильнейший исполнитель
    // против слабейшего рецензента. Пока брался первый маршрут, предложение «поднять chunk
    // до X, правило рецензента сохраняется» приводило к профилю, который сам же
    // `resolveStartableProfile` отказывался стартовать — совет, ломающий запуск.
    const chunkRoutes = this.profile.ensemble.chunk ?? [this.profile.routes.chunk];
    const verifyRoutes = this.profile.ensemble.verify ?? [this.profile.routes.verify];
    const chunk = chunkRoutes.reduce((a, b) => (a.rank >= b.rank ? a : b), this.profile.routes.chunk);
    const verify = verifyRoutes.reduce((a, b) => (a.rank <= b.rank ? a : b), this.profile.routes.verify);
    return suggestEscalation({
      failedClaimsByAttempt: this.failedClaimsByAttempt,
      chunkModelId: chunk.modelId,
      chunkRank: chunk.rank,
      verifyModelId: verify.modelId,
      verifyRank: verify.rank,
      models: this.config.models.models,
    });
  }

  /** Природа красной причины и предложенный ход. `null` — вердикт зелёный или не считался. */
  get lastRedCause(): RedCause | null {
    return this.state.verify.redCause;
  }

  /**
   * Записывает решение человека полем в артефакт: имя оператора и дата.
   *
   * Путь берётся не от клиента: интерфейс называет артефакт коротким именем, а рантайм
   * сам превращает его в путь внутри витка. Иначе поле решения можно было бы записать
   * в произвольный файл на диске — в том числе в чужой виток.
   */
  recordDecision(o: {
    artifact: string;
    label: string;
    /** `false` — решение отрицательное: методология требует записывать и отказ. */
    granted: boolean;
    /** Что именно решил человек. Дописывается к подписи, а не вместо неё. */
    note?: string;
    /** Chunk и попытка, к которым относится решение: клиент называет их явно. */
    chunk?: number;
    attempt?: number;
  }): string {
    if (!isArtifactKey(o.artifact)) {
      throw new Error(`неизвестный артефакт «${o.artifact}»`);
    }

    // Chunk и попытка приходят от клиента, а не берутся текущие: между показом артефакта
    // и нажатием кнопки оператор мог перейти к новой попытке, и подпись ложилась бы в
    // другой файл — тот, которого он не читал.
    const chunk = o.chunk ?? this.chunk;
    const attempt = o.attempt ?? this.attempt;

    const path = artifactPathOf(this.paths, o.artifact, chunk, attempt);
    const current = readArtifact(path);
    // Порча/отсутствие формы — типизированно: вызывающие (bench-драйвер) отличают её от
    // программных поломок раннера классом, а не регуляркой по тексту сообщения.
    if (!current.exists) throw new DecisionFormError(`нет артефакта ${path} — решение записывать некуда`);

    const signature = decisionValue(this.config.runner.operator, new Date());
    const note = (o.note ?? '').trim();
    // Содержательная часть решения сохраняется: `setDecision` заменяет всё после метки,
    // и без этого запись «пропуск найден: claim-4 не покрыт» стиралась подписью.
    const value = o.granted
      ? note === ''
        ? signature
        : `${signature} — ${note}`
      : `**не одобрено** — ${note === '' ? 'причина не названа' : note} · ${signature}`;

    writeArtifact(path, setDecision(current.text, o.label, value));
    // Счётчик перечитывается с диска, а не объявляется нулём: подпись под одним полем не
    // закрывает остальные `‹…›` артефакта, а обёртка `emit` принимает это число за
    // измерение — и долг plan.md исчезал из метрик от решения по одному полю (ревью).
    this.emit({
      type: 'artifact_written',
      runId: this.id,
      stage: null,
      path,
      placeholders: readArtifact(path).placeholders,
    });
    return value;
  }


  /** Каталоги вне проекта, открытые агенту только на чтение. */
  get readOnlyRoots(): string[] {
    return [
      `${this.config.runner.methodologyDir}/templates`,
      this.config.runner.methodologyDir,
      this.config.runner.skillsDir,
    ];
  }

  /**
   * Новая попытка того же chunk'а. Артефакты попытки не перезаписываются: сравнение двух
   * подряд diff'ов — единственный механический детект отсутствия прогресса, и перезапись
   * стирает его улики.
   */
  nextAttempt(): number {
    // Выжимка собирается ДО `resetAttemptState`: он обнуляет вердикт и итоги гейтов, то
    // есть ровно то, из чего она состоит. Порядок здесь значим.
    // Присваивается ВСЕГДА, в том числе `null`: если вердикт на этой попытке не считался,
    // сказать про неё нечего, а оставленная от прошлой попытки выжимка поехала бы в промпт
    // под заголовком «что не сошлось в прошлой попытке» — то есть как свежая.
    this.carryForward =
      this.state.verify.lastVerdictInput === null
        ? null
        : buildRetryBrief(this.state.verify.lastVerdictInput, this.state.verify.lastGateResults, retryDetail(this.host));
    // Средовой красный не должен съедать бюджет итераций — но и переиспользовать номер
    // попытки нельзя: на момент `blocked_env` этап 5 уже отработал, и по этому номеру лежат
    // НАСТОЯЩИЕ улики (патч, запись о тестах, отчёт приёмки). Первая версия не увеличивала
    // счётчик, и следующий проход затирал их — вопреки докстрингу этого же метода.
    //
    // Поэтому номер растёт всегда, а «не занимает попытку» реализовано вычетом: бюджет
    // считается по попыткам, где работа действительно проверялась.
    if (this.state.verify.verdict?.action === 'blocked_env') this.envBlockedAttempts += 1;
    this.attempt += 1;
    this.resetAttemptState();
    this.notePeakAttempt();
    return this.attempt;
  }

  /**
   * Пункты приёмки задачи: id (нижний регистр) → СЫРАЯ строка листа целиком, со всеми
   * колонками. Один разбор на бриф ретрая и на поклаймовый добор — правило «строка листа —
   * источник» живёт в одном месте, но каждый потребитель сам решает, что из неё взять:
   * `retryDetail()` сжимает через `claimTextCell` (см. её докстринг про потолок 12 КБ в
   * карточке шага), а `topUpClaims()` передаёт строку целиком в `packForClaim` — колонка
   * «процедура» там называет конкретный тест/функцию и напрямую улучшает подбор хунков
   * diff'а по словам; урезание её здесь обедняло бы совсем другого потребителя ради
   * потолка байт, которого у него нет.
   */
  private intentClaimLines(intentText?: string): Map<string, string> {
    const out = new Map<string, string>();
    // Текст можно передать готовым: вызывающий, который уже прочитал задачу, не должен
    // заставлять читать её второй раз в том же вызове.
    const text = intentText ?? (readArtifact(this.paths.intent).exists ? readArtifact(this.paths.intent).text : null);
    if (text === null) return out;
    for (const line of text.split(/\r?\n/)) {
      const id = claimIdOf(line);
      if (id !== null && !out.has(id.toLowerCase())) out.set(id.toLowerCase(), line.trim());
    }
    return out;
  }

  /** Следующий chunk витка: нумерация попыток начинается заново. */
  nextChunk(): number {
    this.chunk += 1;
    this.attempt = 1;
    this.envBlockedAttempts = 0;
    // Новый chunk — другая работа: причины красного по прошлому к нему не относятся.
    this.carryForward = null;
    this.failedClaimsByAttempt = [];
    this.resetAttemptState();
    this.notePeakAttempt();
    return this.chunk;
  }

  /**
   * Отмечает достигнутый номер попытки для метрик.
   *
   * Зовётся при СМЕНЕ попытки, а не при расчёте вердикта: пока счёт вёлся только внутри
   * `computeStageVerdict`, попытки, оборванные на этапе 5 или отменённые до verify, в
   * метрики и в пост-виток отчёт не попадали вовсе — то есть отчёт «что съело итерации»
   * занижал ровно то число, ради которого его и завели.
   */
  private notePeakAttempt(): void {
    this.attemptsByChunk.set(
      this.chunk,
      Math.max(this.attemptsByChunk.get(this.chunk) ?? 0, this.attempt),
    );
  }

  /**
   * Состояние, принадлежащее попытке, а не витку.
   *
   * Без сброса `GET /api/runs/:id` после «новой попытки» отдавал гейты и вердикт
   * ПРЕДЫДУЩЕЙ как текущие, и интерфейс рисовал зелёный вердикт рядом с номером попытки,
   * которая ещё не запускалась.
   */
  private resetAttemptState(): void {
    this.state.verify.lastGateResults = [];
    this.state.verify.lastGatesAborted = false;
    this.state.verify.verdict = null;
    this.state.verify.lastVerdictInput = null;
    this.state.verify.redCause = null;
    this.state.verify.reviewerRan = false;
    // Близость к прошлому патчу — свойство ПОПЫТКИ. Пока её тут не было, шапка новой
    // попытки до самого вердикта показывала совпадение от предыдущей, то есть янтарным
    // предупреждала о топтании там, где ещё ничего не сделано.
    this.state.verify.closeness = null;
    // Вердикт этой попытки ещё не считался — счётчики статистики не должны его удвоить
    // при повторном запуске verify (правка набора гейтов и второй прогон — обычное дело).
    this.state.verify.verdictCountedFor = null;
    // Лента — свойство ПОПЫТКИ: вызовы прошлой не должны подтверждать утверждения этой.
    this.attemptToolEvents = [];
    this.attemptObservedFromStart = true;
  }

  /** Набор гейтов проекта. `null` — файла нет. */
  get gatesFile(): GatesFile | null {
    // Кэш по времени правки: один `GET /api/runs/:id` спрашивал набор семь раз (по разу
    // на этап в `blockers` плюс бюджет попыток), и каждый раз это было чтение файла и
    // полный разбор всех его таблиц — синхронно, в том же цикле событий, что и поток
    // WebSocket. Набор — файл проекта: он меняется раз в месяцы, а не раз в запрос.
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.paths.gates).mtimeMs;
    } catch {
      this.gatesCache = null;
      return null;
    }

    if (this.gatesCache?.mtimeMs === mtimeMs) return this.gatesCache.parsed;

    const a = readArtifact(this.paths.gates);
    if (!a.exists) {
      this.gatesCache = null;
      return null;
    }
    const parsed = parseGates(a.text);
    this.gatesCache = { mtimeMs, parsed };
    return parsed;
  }

  /** Строка набора гейта «Разбор последствий» — решение живёт в модуле этапа 4 (`stages/plan.ts`). */
  private axesGateRow(): { name: string } | null {
    return axesGateRowOf(this.gatesFile);
  }

  /** Проблемы разбора последствий — модуль этапа 4 (`stages/plan.ts`); здесь делегат для тестов и verify. */
  axisProblems(): string[] {
    return axisProblemsOf(this.host);
  }

  /** Строки гейтов ранних этапов со статусом рантайма — `stages/verify/gates.ts`; делегат для тестов. */
  earlyGateRows(): { name: string; stage: string; status: string; seenIn: string }[] {
    return earlyGateRowsOf(this.host);
  }

  /** Бюджет попыток из набора гейтов, умолчание методологии — 3. */
  get attemptBudget(): number {
    const DEFAULT = 3;
    const row = this.gatesFile?.rows.find((r) => /бюджет итераций/i.test(r.name));

    // Число берётся ТОЛЬКО у включённой строки. Пока читалась любая, проза выключенной
    // («н/п — долг, скрипт tools/budget2.py») давала бюджет 2, а «вернуться в Q2 2027» —
    // свой мусор: оператор видел «попытка 1 из 2027», и эскалация не наступала никогда.
    if (row === undefined || !row.enabled) return DEFAULT;

    const m = /(\d+)/.exec(row.implementation);
    const parsed = m === null ? NaN : Number(m[1]);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT;

    // Потолок: бюджет — это число попыток человека, а не год из фразы.
    return Math.min(parsed, 20);
  }

  /**
   * Список файлов, в которые разрешена запись, либо `null` — PlanScope выключен.
   *
   * Пустой список при существующем плане — не «разрешено всё», а дефект: так PlanScope
   * выключился бы молча. Такой виток не продолжается (см. `blockers`).
   */
  planFilesFor(stage: StageId): readonly string[] | null {
    if (!PLAN_SCOPED_STAGES.includes(stage)) return null;
    const plan = readArtifact(this.paths.plan);
    if (!plan.exists) return null;
    return extractFilesToTouch(plan.text);
  }

  policyContext(stage: StageId): PolicyContext {
    const def = stageById(stage);
    return {
      projectRoot: this.project.projectRoot,
      stage,
      sdlcDir: `.sdlc/${this.slug}`,
      planFiles: this.planFilesFor(stage),
      protectedArtifacts: def.protectedArtifacts(this.ctx),
      readOnlyRoots: this.readOnlyRoots,
      allowedTools: this.toolsFor(stage),
      mcpTools: rulesForStage(this.mcpSetup, stage),
      readDenied: this.readDeniedFor(stage),
      stageArtifacts: this.stageArtifacts(stage),
      ...(this.config.runner.limits.restoreErasedDecisions === true ? { restoreErasedDecisions: true } : {}),
    };
  }

  /**
   * Ключ артефакта → путь, для `FillField`: пересечение всех известных ключей
   * (`ArtifactKey`) с тем, что этот этап реально производит (`def.produces`). Одна
   * функция на политику и на исполнение (`ExecRequest.stageArtifacts`) — второй разбор
   * здесь разошёлся бы с тем, что действительно решает доступ.
   */
  stageArtifacts(stage: StageId): readonly { key: ArtifactKey; path: string }[] {
    const produced = new Set(stageById(stage).produces(this.ctx));
    const out: { key: ArtifactKey; path: string }[] = [];
    for (const key of ARTIFACT_KEYS_ALL) {
      const path = artifactPathOf(this.paths, key, this.ctx.chunk, this.ctx.attempt);
      if (produced.has(path)) out.push({ key, path });
    }
    return out;
  }

  /**
   * Что закрыто на чтение на этом этапе.
   *
   * Сегодня одно: на этапе 6 — отчёты приёмки ПРЕДЫДУЩИХ попыток этого chunk'а.
   * Методология требует, чтобы рецензент повторной попытки не получал находок прошлой:
   * связь между попытками несут `retry_instruction` и `carry_forward`, которые подаёт
   * машина витка. Живой прогон r23 показал цену доступности: слабая модель списала из
   * соседнего отчёта красный статус гейта, объективно зелёного, и вердикт покраснел по
   * факту, которого в дереве не было.
   *
   * Маршруты ансамбля ТЕКУЩЕЙ попытки не закрываются: они мнения об одном и том же
   * состоянии дерева, а не о прошлой работе, и вердикт сводит их сам по худшему статусу.
   */
  private readDeniedFor(stage: StageId): string[] {
    if (stage !== 'verify') return [];
    const out: string[] = [];
    for (let attempt = 1; attempt < this.attempt; attempt++) {
      for (const route of this.profile.ensemble.verify.keys()) {
        out.push(relOf(this.ctx, this.paths.verificationReport(this.chunk, attempt, route)));
      }
    }
    return out;
  }

  /**
   * Права этапа плюс права на MCP, если оператор выдал этому этапу инструменты.
   *
   * Само определение этапа про MCP не знает и знать не должно: набор инструментов задаётся
   * конфигом ПРОЕКТА, а `stages.ts` общий для всех. Поймано живым прогоном: инструменты
   * модели выдавались, вызов доходил до политики и отклонялся ею — «читающие вызовы MCP не
   * разрешены на этапе», потому что права не выдавал никто.
   */
  /**
   * Заполняет механические поля журнала chunk'а фактами рантайма — см. `journalAutofill.ts`.
   *
   * Идёт и на попытке K>1 (журнал уже существует и посеян не в этот раз): подстановка
   * идемпотентна, а незаполненные механические поля с прошлой попытки не должны съедать
   * ходы и этой. Снимок после подстановки кладётся в `SeededArtifact.snapshot`, чтобы
   * страж «бланк байт-в-байт» не ослеп от нашей же записи.
   */
  /**
   * HEAD проекта: sha либо причина его отсутствия. Одна цепочка на журнал chunk'а и план —
   * две копии разошлись бы при первой же правке (worktree, другой способ чтения HEAD), и
   * база одного витка читалась бы в двух артефактах по-разному.
   */
  private async head(): Promise<{ sha: string | null; why: string }> {
    const root = this.project.projectRoot;
    if (!(await isRepo(root))) return { sha: null, why: 'н/п — не git-репозиторий' };
    if (!(await hasCommits(root))) return { sha: null, why: 'н/п — в репозитории нет коммитов' };
    const r = await git(['rev-parse', 'HEAD'], root);
    return r.code === 0 ? { sha: r.stdout.trim(), why: '' } : { sha: null, why: 'н/п — HEAD не прочитался' };
  }

  /**
   * Запись автозаполнения с обновлением снимка бланка: без снимка страж «бланк байт-в-байт»
   * ослеп бы от нашей же записи, и этап, не сделавший ничего, выглядел бы поработавшим.
   */
  private writeAutofilled(path: string, text: string, seeded: { path: string; snapshot?: string }[]): void {
    writeArtifact(path, text);
    const seed = seeded.find((s) => s.path === path);
    if (seed !== undefined) seed.snapshot = text;
  }

  /**
   * Механические поля плана, готовности и отчётов этапов 2–3 — см. `formAutofill.ts`.
   *
   * Зовётся на входе в этап и повторно перед дозаполнением: модель могла переписать артефакт
   * копией бланка, вернув плейсхолдеры рантайма, а у модели эти поля больше не спрашиваются.
   * Факты (git, существование отчётов) считаются лениво — только когда в артефакте есть что
   * закрывать: повторный вход в этап не должен платить спавнами git за пустую работу.
   */
  private async autofillMechanicalFields(
    stage: StageId,
    seeded: { path: string; snapshot?: string }[],
  ): Promise<void> {
    // Задания — у модулей этапов (`StageModule.mechanicalJobs`); у chunk/verify/handoff их
    // нет, и повторный вызов из `finishFormArtifact` для них ничего не делает.
    const jobs = stageModule(stage).mechanicalJobs?.(this.host) ?? [];

    let total = 0;
    for (const job of jobs) {
      const artifact = readArtifact(job.path);
      // Задание, которому плейсхолдер не нужен (меню «Разведка», `evenWithoutPlaceholders`),
      // зовётся и при нуле мест — остальным закрывать нечего.
      if (!artifact.exists || (artifact.placeholders === 0 && job.evenWithoutPlaceholders !== true)) continue;
      const { text, filled } = await job.fill(artifact.text);
      if (filled === 0) continue;
      this.writeAutofilled(job.path, text, seeded);
      total += filled;
    }
    if (total === 0) return;
    this.emit({
      type: 'warning',
      runId: this.id,
      stage,
      message: `рантайм заполнил механические поля (${total}): название витка, даты, вход и база плана — модели остались содержательные`,
    });
  }

  /**
   * Потолок ходов ЭТАПА: поэтапное значение, иначе общее.
   *
   * Один хелпер на оба места вызова (основной исполнитель и дополнительные маршруты
   * ансамбля) — посчитай их по-разному, и рецензент ансамбля пошёл бы с другим лимитом,
   * чем первый, а сравнивать их отчёты стало бы нечестно.
   */
  private maxTurnsFor(stage: StageId): number {
    const limits = this.config.runner.limits;
    return limits.maxIterationsByStage?.[stage] ?? limits.maxIterationsPerStage;
  }

  /**
   * Учёт расхода для запросов ВНЕ `executor.run()` — `reviewFill`/`claimFill` зовут
   * провайдера напрямую, минуя `hooks.onUsage` (строка ~3703), и без этого метода их
   * токены/стоимость были бы «бесплатными» для `SpentLedger`/`maxBudgetUsd` и не попадали
   * бы ни в `metrics.json`, ни в событие `usage` — тот же учёт, тем же приёмом.
   */
  private accountOffPathUsage(stage: StageId, usage: Usage, currency: string | undefined): void {
    const st = this.stageStats.get(stage);
    if (st !== undefined) st.usage = addUsage(st.usage, usage);
    this.totalUsage = addUsage(this.totalUsage, usage);
    if (countsTowardBudget(this.budgetStages, stage)) {
      this.spent.add(currency ?? 'USD', usage.costUsd);
    }
    this.emit({ type: 'usage', runId: this.id, stage, usage, total: this.totalUsage });
  }

  /**
   * Дозаполнение журнала chunk'а по полям — тем же `FormFillExecutor`, что на
   * этапах-документах, но ПОСЛЕ исполнителя и только над журналом.
   *
   * Границы честности:
   *  - содержательные поля спрашиваются у ТОЙ ЖЕ модели этапа (per-field completion) —
   *    рантайм не сочиняет журнал сам, он снимает с модели цену tool-use за бланк;
   *  - запись идёт через тот же гейт одобрения (внутри FormFillExecutor);
   *  - исход этапа переворачивается в ok ТОЛЬКО когда исполнитель упал именно на
   *    оформлении (лимит ходов / незаполненный артефакт) и после дозаполнения `notDone`
   *    пуст. Любой другой провал (политика, бюджет, отмена) остаётся провалом.
   */
  private async finishFormArtifact(
    stage: StageId,
    path: string,
    result: StageResult,
    prompt: PreparedPrompt,
    hooks: ExecHooks,
    notDone: () => string[],
    signal: AbortSignal,
    /**
     * На chunk — была ли принятая правка кода. `notDone` там смотрит только журнал, и
     * заполненный дозаполнением журнал переворачивал в ok этап, упавший на лимите ходов с
     * нетронутым кодом.
     */
    codeChanged: () => boolean = () => true,
  ): Promise<StageResult> {
    // Честность карты кодовой базы — общий страж для ОБОИХ путей ниже, не только для
    // рескью closableFailure. `FormFillExecutor` у дозаполнения не несёт ни `Read`, ни
    // `Task` (см. комментарий у места вызова), и поле «Карта кодовой базы» дозаполнение
    // может закрыть СОЧИНЁННЫМ путём. Раньше проверка стояла только внутри closableFailure
    // (`!result.ok`) — но дозаполнение зовётся БЕЗУСЛОВНО, когда на диске остались
    // плейсхолдеры, даже если исходный ход уже вернул `ok:true`: страж хода видит файл ДО
    // добора и проверяет более слабое условие («файл тронут», не «плейсхолдеров не
    // осталось»). В этом случае фабрикация в добранных полях проходила мимо проверки и
    // всплывала на шаг позже, на входе в `ask` (живой замер `qwencoder-freeship`, серия
    // v3, 2026-09-13 — пять из шести находок этого класса прошли именно так).
    const explorationHonestyProblem = (): StageResult | null => {
      if (stage !== 'explore') return null;
      const problem = explorationPathProblem(this.ctx);
      return problem === null
        ? null
        : { ...result, ok: false, note: `дозаполнение закрыло плейсхолдеры, но не честность: ${problem}` };
    };

    // Полный журнал — не повод выйти до переворота исхода: живой прогон (r6/ff1) показал
    // сэмпл, где модель добила журнал САМА, но сожгла лимит, не успев завершить ход, —
    // ранний return здесь оставлял этап красным при полностью выполненном контракте.
    // Поля рантайма закрываются заново ДО подсчёта: модель могла переписать артефакт копией
    // бланка, а дозаполнение эти поля у модели не спрашивает — без повтора плейсхолдер
    // рантайма оставался навсегда и держал этап красным.
    await this.autofillMechanicalFields(stage, []);
    let requests = result.modelRequests ?? 0;
    const remaining = countPlaceholdersExceptDecisions(readArtifact(path).text);
    if (remaining > 0) {
      const fill = await this.fillFormFields(stage, path, prompt, hooks, signal);
      requests += fill.modelRequests;
      result = { ...result, ...(requests === 0 ? {} : { modelRequests: requests }) };
      if (!fill.ok) return result;
      const dishonest = explorationHonestyProblem();
      if (dishonest !== null) return dishonest;
    }

    // «Лимит длины ОТВЕТА» — тот же класс, что «исчерпан лимит ходов»: бюджет кончился на
    // оформлении бланка, а не на смысле. Причина возникает только когда модель выдала
    // предельный ответ И НЕ сделала ни одного вызова инструмента (`LoopExecutor`), то есть
    // пыталась напечатать весь артефакт одним куском текста.
    //
    // Замер 2026-09-08 (`bench/results/axes-gptoss32k-*`, `axes-effort-*`): шесть прогонов
    // `gpt-oss-20b` рецензентом, во всех отчёт приёмки остался шаблоном — 141 строка,
    // 20 плейсхолдеров, НОЛЬ упоминаний посева. Мерилась не зоркость, а способность
    // напечатать длинный бланк в одном сообщении.
    //
    // Переворот исхода по-прежнему сторожит `notDone().length === 0`: пустых обязательных
    // полей быть не должно, иначе красное станет зелёным на недоделанном артефакте.
    const closableFailure = !result.ok && isFormattingFailure(result.note);
    if (closableFailure && notDone().length === 0 && (stage !== 'chunk' || codeChanged())) {
      // Рескью нужен своя проверка честности: `remaining` мог быть 0 уже на входе (ход
      // упал не по счётчику плейсхолдеров, а, например, по лимиту длины ответа) — тогда
      // блок выше не запускался вовсе, и это первая проверка для данного прогона.
      const dishonest = explorationHonestyProblem();
      if (dishonest !== null) return dishonest;
      const note =
        'этап закрыт: код и содержание — работа модели, оформление добрано рантаймом ' +
        '(исполнитель упал только на лимите/оформлении при полных артефактах)';
      this.emit({ type: 'warning', runId: this.id, stage, message: note });
      return { ...result, ok: true, note, closedBy: 'runtime' };
    }
    return result;
  }

  /**
   * Дозаполнение полей артефакта per-field completion'ами. `ok: false` — поля не закрылись;
   * `modelRequests` — сколько обращений к модели оно стоило (идёт в итог этапа). Бюджет
   * запросов считает само дозаполнение от числа полей (`fillRequestBudget`).
   */
  private async fillFormFields(
    stage: StageId,
    path: string,
    prompt: PreparedPrompt,
    hooks: ExecHooks,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; modelRequests: number }> {
    const route = this.profile.routes[stage];
    const limits = this.config.runner.limits;
    this.emit({
      type: 'warning',
      runId: this.id,
      stage,
      message: 'артефакт остался с плейсхолдерами — дозаполнение по полям той же моделью, через гейт',
    });

    const fill = await new FormFillExecutor({
      provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, this.trace(stage, 'formFill')),
      maxResultBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
      readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
      bashTimeoutMs: limits.gateTimeoutMs,
      params: route.params,
      ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
      currency: route.providerDef.currency ?? 'USD',
      compact: route.compactForms === 'fill' || route.compactForms === 'all',
      // Образец граничного пункта — из примера эталона, читается в рантайме:
      // замер 2026-09-04 показал ноль `[edge]` в 4 прогонах из 5, а просьба
      // называла только формат (`artifacts/edgeExample.ts`).
      edgeExample: edgeExampleLines(this.config.runner.methodologyDir),
      stage,
    }).run(
      {
        prompt,
        cwd: this.project.projectRoot,
        model: route.model,
        allowedTools: this.toolsFor(stage),
        readOnlyDirs: this.readOnlyRoots,
        subagents: [],
        mcp: null,
        // Поля решений человека не считаются: на отчёте разведки «Решение человека о
        // полноте» остаётся плейсхолдером всегда (humanGate), и страж по общему счётчику
        // краснил дозаполнение при любом заполнении (см. `countPlaceholdersExceptDecisions`).
        finishGuard: () =>
          countPlaceholdersExceptDecisions(readArtifact(path).text) > 0 ? 'в артефакте остались незаполненные поля' : null,
        salvageFromText: null,
        // Дозаполнение лимит ходов не читает — бюджет запросов у него от числа полей
        // (`fillRequestBudget`); поле обязательно для контракта исполнителя.
        maxTurns: this.maxTurnsFor(stage),
        maxBudgetUsd: this.project.maxBudgetUsd,
        spentUsdBefore: this.spent.spent(route.providerDef.currency ?? 'USD'),
        formArtifacts: [path],
        signal,
      },
      hooks,
    );

    if (!fill.ok) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message: `дозаполнение артефакта не закрыло поля: ${fill.note}`,
      });
    }
    return { ok: fill.ok, modelRequests: fill.modelRequests ?? 0 };
  }

  private toolsFor(stage: StageId): readonly ToolName[] {
    const all = stageById(stage).tools;
    // Урезанный набор для модели с `leanTools` — только на этапах-документах. Это
    // ГИПОТЕЗА журнала, а не замер: «сокращение числа инструментов» стоит в списке
    // непробованного (`docs/model-runs.md`), ручка и заведена, чтобы его замерить.
    // Сужаются ПРАВА, не только показ:
    // политика видит тот же список, и второго места решения о доступе не появляется.
    // На chunk/verify набор не трогаем: там Write/Bash нужны по делу.
    const route = this.profile.routes[stage];
    const leaned =
      route.leanTools && stageModule(stage).leanDocTools
        ? all.filter((t) => LEAN_TOOLS.has(t))
        : all;
    // FillField выдаётся ТОЛЬКО при включённой ручке (compactForms 'fill'|'all') — иначе
    // замер этой ручки перестал бы быть замером «одной ручки»: право появлялось бы у всех
    // моделей стадии сразу, без записи в config/models.json, которую и сравнивает журнал.
    const fillFieldOn = route.compactForms === 'fill' || route.compactForms === 'all';
    const base = fillFieldOn ? leaned : leaned.filter((t) => t !== 'FillField');
    const rules = rulesForStage(this.mcpSetup, stage);
    if (rules.length === 0) return base;

    const extra: ToolName[] = [];
    if (rules.some((r) => effectiveMode(r) === 'read')) extra.push('McpRead');
    if (rules.some((r) => effectiveMode(r) === 'write')) extra.push('McpWrite');
    return [...base, ...extra];
  }

  /**
   * Счётчик строки трения. Один на все шесть полей.
   *
   * Вызовы инструментов и напоминания стража — не трение, а фон, на котором трение
   * читается: «ноль вызовов за пятнадцать минут» и «два напоминания и пустой артефакт» —
   * это то, что оператор ищет в постмортеме первым. Раньше их считал отдельный метод с
   * дословно тем же телом; двух одинаковых счётчиков не бывает долго — правка попадает
   * в один и забывается в другом.
   */
  private countFriction(stage: StageId, kind: FrictionKind | 'toolCalls'): void {
    const cur = this.friction.get(stage) ?? EMPTY_FRICTION();
    // `reminder` в событии — единственное число в таблице; поле названо во множественном
    // («сколько напоминаний»), и переименовывать его в контракте ради совпадения с именем
    // события значило бы сломать чтение метрик у клиента.
    const field = kind === 'reminder' ? 'reminders' : kind;
    cur[field] += 1;
    this.friction.set(stage, cur);
  }

  /**
   * Внешние MCP-серверы, выданные этапу: соединения, отбор набора, исполнение вызова.
   *
   * Соединения поднимаются здесь — лениво, на этап. Недоступный сервер этап НЕ роняет:
   * его инструменты просто не попадают в набор, а причина уходит оператору и в промпт.
   * Иначе выключенный редактор превращался бы в непонятный отказ посреди работы.
   */
  private async mcpAccess(stage: StageId): Promise<McpAccess | null> {
    const rules = rulesForStage(this.mcpSetup, stage);
    this.mcpSelected = [];
    if (rules.length === 0 || this.hub.size === 0) return null;

    const servers = [...new Set(rules.map((r) => r.server))];
    const failed = await this.hub.ensureReady(servers);

    for (const name of servers) {
      const s = this.hub.status(name);
      this.emit({
        type: 'mcp_state',
        runId: this.id,
        stage,
        server: name,
        state: s.state,
        reason: s.reason,
        toolCount: s.toolCount,
      });
    }
    for (const name of failed) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message:
          `MCP-сервер «${name}» недоступен: ` +
          `${this.hub.status(name).reason ?? 'причина не названа'}`,
      });
    }

    const selection = selectTools(rules, this.hub.tools(servers), this.mcpSetup.maxInlineTools);
    this.mcpSelected = selection.tools;

    // Отброшенное называется вслух: молча укороченный набор читается как «дали всё».
    for (const d of selection.dropped) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message: `MCP-инструмент ${d.name} не выдан: ${d.why}`,
      });
    }

    if (selection.tools.length === 0) return null;

    const sdkServers: Record<string, unknown> = {};
    for (const spec of this.mcpSetup.servers) {
      if (!servers.includes(spec.name)) continue;
      sdkServers[spec.name] =
        spec.transport === 'http'
          ? { type: 'http', url: spec.url, headers: spec.headers }
          : { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
    }

    const maxBytes = Math.min(
      this.mcpSetup.maxResultBytes,
      this.config.runner.limits.maxToolResultBytes,
    );

    return {
      tools: selection.tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
      })),
      sdkServers,
      pollingTools: servers.flatMap((n) => this.hub.pollingPatterns(n)),
      call: async (server, tool, args, signal) => {
        const outcome = await this.hub.call(server, tool, args, {
          signal,
          fold: {
            saveImage: imageSaver(() =>
              join(this.paths.dir, 'mcp', `${stage}-${this.chunk}-${++this.mcpImageSeq}`),
            ),
          },
        });
        return { ok: outcome.ok, text: cap(outcome.text, maxBytes) };
      },
    };
  }

  /** Недоступные серверы витка с причинами — для честной строки в промпте. */
  private mcpUnavailable(): { name: string; reason: string }[] {
    return this.hub
      .names()
      .map((name) => ({ name, status: this.hub.status(name) }))
      .filter((x) => x.status.state === 'unavailable')
      .map((x) => ({ name: x.name, reason: x.status.reason ?? 'причина не названа' }));
  }

  /** Набор MCP-инструментов последнего запуска этапа и его цена — для интерфейса. */
  mcpStageInfo(): { tools: string[]; estimatedTokens: number } {
    return {
      tools: this.mcpSelected.map((t) => t.name),
      estimatedTokens: estimateTokens(this.mcpSelected),
    };
  }

  /** Состояние серверов для панели оператора. */
  mcpServers(): McpServerInfo[] {
    const selected = new Map<string, string[]>();
    for (const t of this.mcpSelected) {
      const list = selected.get(t.server) ?? [];
      list.push(t.tool);
      selected.set(t.server, list);
    }
    return this.hub.info(selected);
  }

  /**
   * Метка сырого дампа запросов к модели (`provider/rawLog.ts`) — корпус «вход → выход»
   * для замеров и обучения. Собирается здесь, потому что только виток знает слаг и номер
   * попытки; сам дамп выключен, пока не задан `SDLC_RAW_LOG_DIR`.
   */
  private trace(stage: StageId, mode: TraceLabel['mode']): TraceLabel {
    return { slug: this.slug, stage, mode, attempt: this.attempt };
  }

  /**
   * Исполняется ли этап заполнением по полям (`FormFillExecutor`) целиком.
   *
   * Одно место решения на двоих: по нему выбирается исполнитель И собирается промпт.
   * Пока условие было только внутри `executorFor`, промпт про режим не знал и обещал
   * модели инструменты, которых в поштучном запросе нет, — замер 2026-09-04 показал, чем
   * это кончается (`BuildPromptInput.formFill`).
   */
  private usesFormFill(stage: StageId, route: ResolvedRoute): boolean {
    return route.formFill && stageModule(stage).formFillExecutor;
  }

  /**
   * Чем проект собирается — тем же источником, что у гейтов (`describeBuild`). Одна функция
   * на промпт, индекс разведки и конвейер: второй детект разошёлся бы с первым.
   */
  private ecosystemFor(stage: StageId): EcosystemLine[] {
    return describeBuild({
      projectRoot: this.project.projectRoot,
      planFiles: this.planFilesFor(stage) ?? [],
      baseline: null,
      timeoutMs: this.config.runner.limits.gateTimeoutMs,
      ...(this.project.modules === undefined ? {} : { modules: this.project.modules }),
    });
  }

  private executorFor(stage: StageId, forRoute?: ResolvedRoute): StageExecutor {
    const route = forRoute ?? this.profile.routes[stage];
    if (route.flow === 'sdk') {
      // `stepFill`/`formFill` — ручки исполнителей флоу `loop`, у `sdk` своего цикла нет,
      // и молчаливое игнорирование выглядело бы как «настройка не сработала», не как
      // «настройка сюда не применима». Оператор обязан узнать об этом из панели, а не
      // догадываться по факту, что этап шёл как обычно.
      if (route.stepFill) {
        this.emit({
          type: 'warning',
          runId: this.id,
          stage,
          message: `stepFill включён у модели с flow «sdk» — ручка действует только для flow «loop», для этого этапа она проигнорирована`,
        });
      }
      if (route.exploreFill) {
        this.emit({
          type: 'warning',
          runId: this.id,
          stage,
          message: `exploreFill включён у модели с flow «sdk» — ручка действует только для flow «loop», для этого этапа она проигнорирована`,
        });
      }
      return new SdkExecutor();
    }

    const limits = this.config.runner.limits;

    // Этап 2 конвейером рантайма (`ModelDef.exploreFill`): индекс, карточки, закрытые
    // вопросы, запись через гейт — `exec/ExploreExecutor.ts`. Слепой лист уже посчитан в
    // `runStage` (`runClaimsBlind`) и лежит в `exploreClaims`.
    if (stage === 'explore' && usesExploreFill(route)) return exploreFillExecutor(this.host, route);

    // Режим заполнения по полям — только там, где этап и есть заполнение бланка.
    // Explore сюда не входит: его отчёт пишется по результатам разведки субагентами,
    // а не выводится из входов; chunk/verify — тем более.
    if (this.usesFormFill(stage, route)) {
      return new FormFillExecutor({
        provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, this.trace(stage, 'formFill')),
        maxResultBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
        readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
        bashTimeoutMs: limits.gateTimeoutMs,
        params: route.params,
        // Расчёт `max_tokens` по остатку окна (`FormFillExecutor.paramsFor`) — тот же приём,
        // что у `StepExecutor`/`ExploreExecutor`; до этой правки маршруты `compactForms`
        // с объявленным `contextWindow` не получали от него никакой защиты здесь
        // (code-review-all, 2026-09-14).
        ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
        currency: route.providerDef.currency ?? 'USD',
        // Схема формы вместо сплошного текста — см. `ModelDef.compactForms`.
        compact: route.compactForms === 'fill' || route.compactForms === 'all',
        // Образец граничного пункта — из примера эталона, читается в рантайме:
        // замер 2026-09-04 показал ноль `[edge]` в 4 прогонах из 5, а просьба
        // называла только формат (`artifacts/edgeExample.ts`).
        edgeExample: edgeExampleLines(this.config.runner.methodologyDir),
        stage,
      });
    }

    // Этап 5 по шагам плана (`ModelDef.stepFill`): цикл ведёт рантайм, модель отвечает на
    // один шаг без tool-use. Только chunk — на других этапах шагов плана нет. Карта шагов
    // показывается оператору ДО старта: это замена подтверждению места правки человеком
    // (Phase 2 методологии), которого в режиме без `AskHuman` нет.
    if (stage === 'chunk' && route.stepFill) return stepFillExecutor(this.host, route);

    return new LoopExecutor({
      provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, this.trace(stage, 'loop')),
      // Свой потолок у локального контура: общий рассчитан на большое окно, а здесь один
      // `Read` по нему забирал почти весь контекст 16K — измерено на прогоне.
      maxResultBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
      readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
      bashTimeoutMs: limits.gateTimeoutMs,
      // Температуру не задаём: у части серверов «не задано» и «0» ведут себя по-разному,
      // и подставлять своё значение молча — значит менять поведение модели за оператора.
      // Оператор задаёт её (и любой другой параметр) сам — в `params` записи модели.
      temperature: null,
      params: route.params,
      currency: route.providerDef.currency ?? 'USD',
      historyBudgetBytes: limits.localHistoryBudgetBytes,
      // Расчёт `max_tokens` по остатку окна (`LoopExecutor.paramsFor`) — то же поле,
      // которым уже сверяется загрузка LM Studio (`lmstudioContext.ts`), не второе знание.
      ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
    });
  }

  /**
   * Индекс проекта для разведки (`explore/*`) — по задаче на диске, с кэшем (см. поле).
   * Экосистема приходит от вызывающего тем же `describeBuild`, что у гейтов и блока
   * `ecosystem`: второй детект здесь разошёлся бы с первым.
   */
  exploreIndexFor(ecosystem: readonly EcosystemLine[]): { index: ExploreIndex; kw: Keywords; built: BuiltView } {
    return exploreIndexOf(this.host, ecosystem);
  }

  /**
   * Готовит промпт этапа, не запуская его. Отдельный шаг, потому что оператор вправе
   * отредактировать промпт до отправки — а значит, он должен увидеть его раньше.
   */
  preparePrompt(stage: StageId, opts: { requirement?: string; extra?: string } = {}): PreparedPrompt {
    // Диагноз прошлой попытки попадает уже в собранный промпт, а не подклеивается позже:
    // промпт уходит в шину и редактируется оператором, и всё, что уйдёт в модель, должно
    // быть видно ему до запуска. Проверка на вхождение — от второго экземпляра, когда
    // `runStage` уже подмешал тот же блок в `extra`.
    if (
      stage === 'chunk' &&
      this.carryForward !== null &&
      !(opts.extra ?? '').includes(this.carryForward)
    ) {
      const carried = this.carryForward;
      opts = {
        ...opts,
        extra: opts.extra === undefined ? carried : `${opts.extra}\n\n${carried}`,
      };
    }

    const def = stageById(stage);
    const route = this.profile.routes[stage];
    // Один разбор plan.md на сборку промпта: и для describeBuild, и для prefetch ниже.
    const chunkPlanFiles = stage === 'chunk' ? (this.planFilesFor(stage) ?? []) : [];
    const ecosystem = this.ecosystemFor(stage);
    const prompt = buildPrompt({
      runner: this.config.runner,
      stage: def,
      ctx: this.ctx,
      flow: route.flow,
      slug: this.slug,
      compactForms: route.compactForms,
      // Тем же условием, каким выбирается исполнитель: промпт обязан знать, что
      // инструментов в запросах этого этапа не будет.
      formFill: this.usesFormFill(stage, route) || (stage === 'explore' && usesExploreFill(route)),
      // Эффективный набор, а не `stage.tools`: урезание `leanTools` обязано быть видно
      // в промпте — панель показывает ровно тот список, с которым уйдёт запрос.
      // MCP-права здесь не нужны: у внешних инструментов своя строка в adapter-блоке.
      tools: this.toolsFor(stage).filter((t) => t !== 'McpRead' && t !== 'McpWrite'),
      now: new Date(),
      ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
      ...(opts.extra === undefined ? {} : { extra: opts.extra }),
      // Чем проект собирается — тем же источником, что у гейтов. Пусто (плана ещё нет,
      // экосистема не определилась) — блок в промпте молчит, а не гадает.
      ...(ecosystem.length === 0 ? {} : { ecosystem }),
      // Индекс проекта — под ручками `exploreIndex`/`exploreFill` (см. `ModelDef`): конвейер
      // тоже показывает его в промпте — оператор видит те же кандидаты, что уйдут в карточки.
      ...(stage === 'explore' && (route.exploreIndex || route.exploreFill)
        ? {
            exploreIndex: this.exploreIndexFor(ecosystem).built.view,
            // Бюджет блока индекса режется по остатку ЭТОГО окна (`prompt/build.ts`) — то
            // же поле, что уже сверяет загрузку LM Studio и режет `max_tokens` в исполнителях.
            ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
          }
        : {}),
      // Набор MCP-инструментов и состояние серверов: считаются до сборки промпта, чтобы
      // панель промпта показывала ровно то, что уходит в модель.
      ...(this.mcpSelected.length === 0 ? {} : { mcpTools: this.mcpSelected }),
      ...(this.mcpUnavailable().length === 0 ? {} : { mcpUnavailable: this.mcpUnavailable() }),
      ...(this.seeded.length === 0 ? {} : { seededArtifacts: this.seeded }),
      // Prefetch файлов плана в промпт этапа 5 (флоу loop) — тем же источником, что у
      // политики: второй разбор плана разошёлся бы с ней. Один вызов, не два: каждый
      // читает и парсит plan.md с диска.
      ...(chunkPlanFiles.length > 0 ? { planFiles: chunkPlanFiles } : {}),
    });
    this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    return prompt;
  }

  /**
   * Причины, по которым этап не начинается. Пустой массив — можно стартовать.
   *
   * `precomputed` передаётся, когда предусловия уже посчитаны вызывающим: `runStage`
   * считал их дважды подряд ради одного и того же ответа.
   */
  blockers(
    stage: StageId,
    opts: { abortHandoff?: boolean } = {},
    precomputed?: PreconditionReport,
  ): string[] {
    // Виновник здесь не считается: `blockers()` зовут GET-ручки на каждый опрос витка, а
    // виновник нужен только отчёту стенда.
    return this.blockerDetails(stage, opts, precomputed, false).map((b) => b.text);
  }

  /**
   * Те же причины, что `blockers`, с этапом-виновником каждой: чей артефакт завалил вход.
   * `null` — причина не про артефакт прошлого этапа (проба среды песочницы, недостающее
   * решение человека). Виновник всегда выводится `stageProducing` из пути артефакта — второе
   * место решения «кто виноват» разошлось бы с `produces` этапов при первой их правке.
   */
  blockerDetails(
    stage: StageId,
    opts: { abortHandoff?: boolean } = {},
    precomputed?: PreconditionReport,
    withBlame = true,
  ): { text: string; blamed: StageId | null }[] {
    const report = precomputed ?? checkPreconditions(stageById(stage), this.ctx, { ...opts, withArtifacts: withBlame });
    const blame =(path: string | null): StageId | null =>
      withBlame && path !== null ? stageProducing(path, stage, this.ctx) : null;
    const problems: { text: string; blamed: StageId | null }[] = report.details.map((d) => ({
      text: d.text,
      blamed: blame(d.artifact),
    }));
    const by = (blamed: StageId | null) => (text: string) => ({ text, blamed });

    if (PLAN_SCOPED_STAGES.includes(stage)) {
      const files = this.planFilesFor(stage);
      if (files !== null && files.length === 0) {
        problems.push(
          by(blame(this.paths.plan))(
            `план ${this.paths.plan} есть, но files_to_touch пуст: PlanScope выключился бы молча, ` +
              `и запись перестала бы быть ограниченной планом. Заполни секцию files_to_touch.`,
          ),
        );
      }
    }

    // Обязательная пятёрка проверяется на старте КАЖДОГО этапа, кроме первого: именно
    // на первом набор и собирают. Проверять её только на этапе 6 значило бы узнавать
    // о несобранном наборе, потратив весь виток.
    //
    // Объявленный обрыв витка из-под этой проверки выведен намеренно: handoff при обрыве —
    // единственный способ оставить запись о том, почему виток бросили, и запирать его
    // тем же несобранным набором значило бы лишить виток последнего легального выхода.
    if (stage !== 'intent' && !(stage === 'handoff' && opts.abortHandoff === true)) {
      const gates = this.gatesFile;
      const gatesBlame = blame(this.paths.gates);
      if (gates === null) {
        problems.push(
          by(gatesBlame)(
            `нет набора гейтов ${this.paths.gates}. Без него не определены ни «сделано», ни ` +
              `условия вердикта — виток не стартует.`,
          ),
        );
      } else {
        problems.push(...configProblems(gates).map(by(gatesBlame)));
        // `REVIEW_GATE` не в BUILTIN и не в кавычках, но НЕ является дырой в наборе: он
        // получает статус не скриптом gates/run.ts, а `externalGateStatuses()` (`stages/verify/gates.ts`) — тем
        // же путём, каким и реально считается на прогоне (см. `runGates({ externalStatuses:
        // this.externalGateStatuses() })`). Без этого исключения витки с обычным для
        // минимума набором никогда бы не проходили дальше intent.
        problems.push(
          ...unimplementedGates(gates, (name) => builtinFor(name) !== null, [REVIEW_GATE]).map(by(gatesBlame)),
        );
      }
    }

    // Последний ИЗВЕСТНЫЙ (не обязательно свежий — см. `lastPreflightBlockers`)
    // pre-flight-статус песочницы: без этого GET-ручки, которые как раз для того и зовут
    // `blockers()`, чтобы показать оператору «почему этап нельзя начать» ДО клика «Старт»,
    // никогда не видели провал пробы среды — он всплывал только ошибкой уже начавшегося
    // `runStage`. Отдельная ветка от `preflightBlockers` (не встроена в неё саму) — та
    // асинхронна (ходит в Docker), а `blockers()` обязан остаться синхронным: он вызывается
    // на каждый опрос списка витков, и дёргать Docker на каждый такой опрос было бы дороже
    // самой проблемы, которую чинит.
    if (stage === 'verify') {
      problems.push(...this.state.verify.lastPreflightBlockers.map(by(null)));
    }

    return problems;
  }

  /** Прогон автоматических гейтов этапа 6 рантаймом до ревью — `stages/verify/gates.ts`. */
  async runVerifyGates(signal?: AbortSignal): Promise<GateRunResult[]> {
    return runVerifyGatesOf(this.host, signal);
  }

  /**
   * Принять содержимое артефакта, напечатанное в ответ вместо вызова инструмента.
   *
   * Три вещи, которые здесь важнее самой возможности:
   *
   *  1. Запись идёт **через гейт одобрения**, как любая другая: рантайм не доверяет тексту,
   *     он предлагает оператору вызов, который тот видит и может отклонить.
   *  2. Пишутся только файлы, которые этап и так вправе произвести: `produces` этапа, а на
   *     этапе 5 ещё и `files_to_touch` одобренного плана — не «всё, что похоже на файл».
   *     Расширение на план закрывает главный замеренный провал локальных исполнителей:
   *     `qwen2.5-coder` печатала содержимое ФАЙЛОВ КОДА текстом вместо `Write`, и ход
   *     сгорал, хотя правка была составлена (см. `docs/model-runs.md`).
   *  3. Вызывается только когда страж уже сказал, что артефакт пуст: это спасение хода,
   *     а не второй, тихий способ записи в обход инструментов.
   */
  private async salvageFromText(
    text: string,
    produced: readonly string[],
    stage: StageId,
  ): Promise<string | null> {
    // Пути плана — относительные POSIX; спасение оперирует абсолютными, как `produces`.
    // Два фильтра, оба про безопасность, а не про удобство:
    //  - абсолютный путь в плане `join` не «абсолютизирует», а приклеивает к корню —
    //    вышла бы запись в бессмысленный путь внутри проекта;
    //  - СУЩЕСТВУЮЩИЙ файл спасением не переписывается: механизм спроектирован под
    //    бланк, где напечатанный текст и есть весь файл. Модель, напечатавшая «вот как
    //    теперь выглядит функция X» под именем файла, дала бы Write, заменяющий сотни
    //    строк фрагментом, — а карточка одобрения выглядела бы как обычная запись.
    //    Новый файл из плана — единственный случай, где блок текстом и файл совпадают.
    const planTargets =
      stage === 'chunk'
        ? (this.planFilesFor('chunk') ?? [])
            .filter((rel) => !isAbsolute(rel))
            .map((rel) => join(this.project.projectRoot, rel))
            .filter((abs) => !existsSync(abs))
        : [];
    const blocks = salvageBlocks(text, [...produced, ...planTargets]);
    if (blocks.length === 0) return null;

    const written: string[] = [];
    for (const b of blocks) {
      const call: NormalizedCall = { kind: 'write', path: b.path, content: b.content };
      const decision = await this.gate.request({
        runId: this.id,
        stage,
        requestId: `salvage-${this.salvageSeq++}`,
        toolName: 'Write',
        rawInput: { file_path: b.path, content: b.content },
        call,
        ctx: this.policyContext(stage),
      });
      if (!decision.allowed) continue;
      // Правка оператора применяется, как на любом другом пути записи: он открыл карточку,
      // исправил содержимое и одобрил ИСПРАВЛЕННОЕ. Игнорировать `updatedInput` здесь
      // значило бы записать на диск не то, что он подтвердил, — при том что сообщение в
      // журнал утверждает «записано через гейт одобрения».
      const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
      const content = typeof edited === 'string' ? edited : b.content;
      writeArtifact(b.path, content);
      written.push(b.path);
    }

    if (written.length === 0) return null;
    return (
      `содержимое артефакта было напечатано в ответ, а не записано инструментом — ` +
      `рантайм записал его через гейт одобрения: ${written.join(', ')}`
    );
  }

  /**
   * Отмечает, что независимый рецензент отработал на этой попытке.
   *
   * Ставится исполнителем при фактическом вызове субагента, а не наличием файла: это
   * единственный факт, по которому гейт минимума может стать зелёным.
   */
  markReviewerRan(): void {
    this.state.verify.reviewerRan = true;
  }

  /**
   * Вердикт этапа 6 по отчёту приёмки и фактическому прогону гейтов.
   *
   * Считается кодом, а не моделью: слабый рецензент может ошибиться в статусе, но
   * ложный зелёный выдать не может.
   */
  computeStageVerdict(noProgress = false): Verdict | null {
    // Расчёт — `stages/verify/verdict.ts`; здесь учёт попытки в метриках витка и событие.
    const computed = stageVerdict(this.host, noProgress);
    if (computed === null) return null;
    const { verdict: withNotes, input } = computed;

    // Статистика попытки учитывается РОВНО ОДИН РАЗ. Пересчёт вердикта на той же попытке
    // (оператор поправил набор гейтов и запустил verify снова) обязан обновить сам
    // вердикт, но не удваивать историю: иначе одна неудача выглядит как две.
    const key = `${this.chunk}:${this.attempt}`;
    if (this.state.verify.verdictCountedFor !== key) {
      this.state.verify.verdictCountedFor = key;
      // Гейт-агрегаты — по тем же статусам, что ушли в вердикт: рантайм видел прогон
      // рецензента своими глазами, и `⏭`, стоявшее там до его вызова, метрикой не является.
      for (const g of gateResultsForVerdict(this.host)) this.recordGateResult(g);
      this.recordIteration(withNotes, noProgress);
      this.verdictCount += 1;
      if (!withNotes.passed) this.redCount += 1;
      if (this.state.verify.redCause !== null) {
        this.redByCause.set(this.state.verify.redCause.kind, (this.redByCause.get(this.state.verify.redCause.kind) ?? 0) + 1);
      }
      // `manual` сюда не идёт: пункт, освобождённый человеком от автоматической проверки,
      // «не закрывается вторую попытку подряд» по построению, и предложение поднять модель
      // из-за него — совет лечить то, что не болеет.
      this.failedClaimsByAttempt.push(
        input.claims.filter((c) => c.status !== '✅' && c.status !== 'manual').map((c) => c.id),
      );
    }
    this.emit({ type: 'verdict', runId: this.id, stage: 'verify', verdict: withNotes });
    return withNotes;
  }

  /**
   * Блокер, если рабочее дерево стоит не на ветке, объявленной задачей.
   *
   * `null` — либо ветка совпадает, либо проверять не с чем: не git-репозиторий, поле
   * «Ветка витка» не заполнено или в нём плейсхолдер (`intent.md` этого не требует —
   * поле по форме опционально текстом-подсказкой «‹sdlc/слаг или по конвенции проекта›»,
   * и виток без него не бракуется, просто теряет эту конкретную защиту). Заполненное
   * поле — обязательство, которое Runner проверяет за оператора: тот самый коммит на
   * `main` из AUTH-104 обнаружился только гейтом «Проверка предусловий публикации» на
   * этапе 7, когда правка уже легла на неверную ветку.
   */
  private async branchMismatchBlocker(): Promise<string | null> {
    const rawField = readField(readArtifact(this.paths.intent).text, 'Ветка витка');
    if (rawField === null) return null;
    const declared = branchNameFromField(rawField);
    if (!(await isRepo(this.project.projectRoot))) return null;

    const actual = await currentBranch(this.project.projectRoot);
    if (actual === declared) return null;
    return (
      `рабочее дерево на ветке «${actual}», а задача объявляет «${declared}» (intent.md → ` +
      `«Ветка витка»). Правка в этом состоянии легла бы не туда — переключись на нужную ветку ` +
      `сам (\`git checkout -b ${declared}\` или \`git checkout ${declared}\`) и начни попытку ` +
      `заново; Runner не переключает ветку автоматически, чтобы не тронуть незакоммиченное.`
    );
  }

  /** Отменяет текущий этап: и исполнителя, и всё, что ждёт ответа оператора. */
  cancel(reason: string): void {
    this.aborter?.abort();
    this.gate.cancelRun(this.id, reason);
    this.askGate.cancelRun(this.id);
    this.status = 'cancelled';
  }

  /**
   * Конец витка: гасим внешние MCP-серверы.
   *
   * Именно на конце витка, а не этапа. Погасив редактор между chunk и verify, мы отняли бы
   * у верификации ровно то состояние, которое она и проверяет, — и следующий этап платил
   * бы за подъём редактора заново.
   */
  async dispose(): Promise<void> {
    await this.hub.close();
  }

  async runStage(stage: StageId, opts: RunStageOptions = {}): Promise<StageResult> {
    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const abortOpts = opts.abortHandoff === true ? { abortHandoff: true } : {};

    // Кэш предыдущего pre-flight сбрасывается ДО проверки блокеров ниже: если прошлая
    // попытка упала на пробе среды, `this.state.verify.lastPreflightBlockers` от неё ещё не пуст, а
    // `blockers()` теперь подмешивает его в свой список (см. её комментарий) — без сброса
    // здесь виток заблокировал бы сам себя устаревшим результатом, ни разу не пройдя до
    // свежей проверки ниже, и retry стал бы физически недостижим.
    if (stage === 'verify') this.state.verify.lastPreflightBlockers = [];
    // Кэш индекса разведки ключуется по тексту задачи и экосистеме, а не по состоянию
    // дерева проекта: тот же ключ мог совпасть у ДВУХ разных попыток этапа (тот же intent,
    // тот же стек), пока между ними в целевом проекте появился/изменился файл — и второй
    // проход тихо получал бы дерево первого. Сброс НА ВХОДЕ в этап — тот же приём, что у
    // `lastPreflightBlockers` выше; в пределах одного прохода `exploreIndexFor` по-прежнему
    // считает дерево один раз на 2–3 вызова (ревью code-review-all, 2026-09-11).
    if (stage === 'explore') this.state.explore.indexCache = null;

    // Предусловия считаются ОДИН раз: `blockers` вызывает `checkPreconditions` внутри,
    // и второй вызов рядом был чистым дублированием чтения артефактов, хотя комментарий
    // рядом утверждал обратное.
    const report = checkPreconditions(def, this.ctx, { ...abortOpts, withArtifacts: false });
    const blockers = this.blockers(stage, abortOpts, report);
    if (blockers.length > 0) {
      const message = blockers.join('\n');
      // Статус обязан отразить неудачный вход в этап: пока он оставался от предыдущего,
      // в списке витков заблокированный запуск выглядел как «этап пройден».
      this.status = 'failed';
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    }

    if (report.skip !== null) {
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: true, note: report.skip });
      return { ok: true, finalText: '', usage: emptyUsage(), note: report.skip };
    }

    // Только «Тесты»/«Сборка» реально идут через `runShell`, и только на этапе 6 — pre-flight
    // здесь, а не после запуска модели: несоответствие среды раньше обнаруживалось только
    // прогоном самих гейтов, то есть после того, как разведка и отчёт уже съели попытку.
    // До `nextAttempt()` (отдельный метод, не вызывается отсюда) — попытка не тратится.
    // ПОСЛЕ проверки `report.skip`, не до неё: у `verify` пропуска сегодня не бывает
    // (`stages.ts::skipIf` для него всегда `null`), но если он появится — pre-flight не
    // должен блокировать попытку, которая всё равно была бы пропущена без него.
    if (stage === 'verify') {
      const sandboxBlockers = await preflightBlockers(this.project.projectRoot, this.project.name);
      this.state.verify.lastPreflightBlockers = sandboxBlockers;
      if (sandboxBlockers.length > 0) {
        const message = sandboxBlockers.join('\n');
        this.status = 'failed';
        this.emit({ type: 'error', runId: this.id, stage, message });
        return { ok: false, finalText: '', usage: emptyUsage(), note: message };
      }
    }

    // `chunk` — первый этап, где модель реально пишет в рабочее дерево (`Write`/`Edit`), но
    // не единственный, где доступен `Bash`: по `stages.ts` он разрешён также на `plan`,
    // `verify` и `handoff` (на `intent` — тоже, но поле «Ветка витка» ещё не заполнено на
    // входе в него, блокер там всегда `null` — перепроверять нечего). `git checkout` внутри
    // Bash-вызова может сменить ветку уже ПОСЛЕ того, как поле заполнено на `intent`, и
    // проверка только на входе в `chunk` эту смену не поймает вплоть до гейта «Проверка
    // предусловий публикации» на `handoff`, который находит её ПОСЛЕ коммита — ровно тот
    // постфактум-сценарий AUTH-104, ради которого блокер и заводился. Перепроверяем на
    // входе в каждый из этапов, где Bash в принципе доступен И поле уже может быть
    // заполнено. Не переключаем ветку автоматически: `git checkout` посреди грязного дерева
    // — свой источник потери рабочих файлов, а решение, что считать «текущей задачей»,
    // принимает человек.
    if (stage === 'plan' || stage === 'chunk' || stage === 'verify' || stage === 'handoff') {
      const branchBlocker = await this.branchMismatchBlocker();
      if (branchBlocker !== null) {
        this.status = 'failed';
        this.emit({ type: 'error', runId: this.id, stage, message: branchBlocker });
        return { ok: false, finalText: '', usage: emptyUsage(), note: branchBlocker };
      }
    }

    const { agents, missing } = loadSubagents(this.config.runner.agentsDir, def.subagents);
    if (missing.length > 0) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message:
          `не найдены определения субагентов: ${missing.join(', ')} (каталог ${this.config.runner.agentsDir}). ` +
          (stage === 'verify'
            ? 'Этап 6 пойдёт без независимого рецензента, а «Ревью независимым агентом» ' +
              'входит в минимальную пятёрку гейтов — вердикт этого витка неполон.'
            : 'Этап пойдёт без независимого агента: ограничение прав держится на промпте, ' +
              'а не на конструкции.'),
      });
    }

    this.emit({
      type: 'stage_started',
      runId: this.id,
      stage,
      flow: route.flow,
      provider: route.provider,
      model: route.model,
      chunk: this.chunk,
      attempt: this.attempt,
    });
    this.status = 'running';
    this.aborter = new AbortController();

    // Метрики этапа копятся на витке: сколько раз он запускался, сколько это стоило и
    // сколько занял. Время меряется здесь, а не по событиям шины: буфер шины вытесняет
    // старое, и считать по нему длительность значило бы терять её на длинных витках.
    const stageStartedAt = Date.now();
    const stat = this.stageStats.get(stage) ?? { runs: 0, usage: emptyUsage(), durationMs: 0 };
    stat.runs += 1;
    this.stageStats.set(stage, stat);

    if (stage === 'chunk') await ensureBaseline(this.host);

    // Гейты этапа 6 прогоняются до рецензента и подклеиваются к его входу: иначе он
    // судит по своему представлению о сборке и тестах, а не по их фактическому итогу.
    //
    // Подклеиваются ВСЕГДА, в том числе к промпту, который оператор редактировал.
    // Условие «только если промпт собран рантаймом» на практике не выполнялось никогда:
    // интерфейс отправляет содержимое textarea при каждом запуске, поэтому рецензент не
    // получал итогов гейтов ни разу, а оператор на каждом прогоне видел предупреждение
    // о правке, которой не делал. Блок фактов от прогона — не «дополнение промпта за
    // спиной»: без него этап 6 не исполняет порядок, ради которого он и устроен.
    let extra = opts.extra;
    /** Что подклеил сам рантайм — только это дописывается к промпту, отредактированному
     *  оператором. Раньше признак был выражен условием `stage === 'verify'` в месте
     *  склейки, и второй источник фактов (диагноз ретрая) туда бы просто не попал. */
    let appended: string | undefined;

    if (stage === 'verify') {
      // Записи принадлежат ПОПЫТКЕ: перезапуск этапа начинает отчёт заново, и пункты
      // прошлого прогона не должны в него переезжать — той же логикой, по которой отчёты
      // прошлых попыток закрыты на чтение.
      this.state.verify.claimRecords.clear();
      this.state.verify.findingRecords = [];
      this.state.verify.anchorHaystack = null;
      this.state.verify.reviewFillComplete = false;

      const results = await this.runVerifyGates(this.aborter.signal);
      if (results.length > 0) {
        appended = gateReportBlock(results);
        extra = extra === undefined ? appended : `${extra}\n\n${appended}`;
      }
    }

    // Диагноз прошлой попытки — вход повторного chunk'а. Без него ретрай уходил тем же
    // промптом, что и первая попытка: причины красного посчитаны, но до исполнителя не
    // доезжали, и он заново угадывал, что именно не сошлось.
    if (stage === 'chunk' && this.carryForward !== null) {
      appended = this.carryForward;
      extra = extra === undefined ? appended : `${extra}\n\n${appended}`;
    }

    // Ветка рабочего дерева — вход этапа 1, тем же механизмом: рантайм знает её точно,
    // и модели незачем выводить имя из путей `.sdlc/…` (свип 2026-09-08, см. комментарий
    // у `branchFactBlock`).
    if (stage === 'intent') {
      const block = await branchFactBlock(this.project.projectRoot);
      if (block !== null) {
        appended = appended === undefined ? block : `${appended}\n\n${block}`;
        extra = extra === undefined ? block : `${extra}\n\n${block}`;
      }
    }

    // Пост-виток отчёт — вход этапа 7, тем же механизмом, что и итоги гейтов на этапе 6:
    // модель переносит числа в артефакт, но не сочиняет их.
    if (stage === 'handoff') {
      const block = postmortemBlock(this.metrics, profileCurrency(this.profile));
      if (block !== null) {
        appended = block;
        extra = extra === undefined ? block : `${extra}\n\n${block}`;
      }
    }

    // Соединения к MCP поднимаются ДО сборки промпта: набор инструментов, показанный
    // оператору, обязан быть тем же, что уйдёт в модель, а он зависит от того, какие
    // серверы реально ответили.
    const mcp = await this.mcpAccess(stage);

    // Формы раскладываются ДО этапа: «заполни бланк» — задача другого класса, чем «создай
    // документ по форме», и на локальных моделях это ровно тот шаг, где они вставали.
    // Снимок отсутствующего берётся ДО раскладки: по нему потом видно, произвёл ли этап
    // хоть что-то, а существовавший ранее файл (набор гейтов проекта) доказательством не
    // считается.
    // Снимок рабочего дерева ДО этапа: «дерево не изменилось» обязано считаться против
    // него, а не против HEAD. Коммита до этапа 7 не бывает, поэтому правки прошлой попытки
    // и прошлого chunk'а остаются в дереве, и сравнение с HEAD объявляло бы результативной
    // любую попытку после первой удачной.
    const diffBefore =
      stage === 'chunk' ? await workingDiff(this.project.projectRoot, [], this.aborter?.signal) : '';

    // Строка трения заводится ДО исполнителя. Пока она создавалась первым же счётчиком,
    // этап, не сделавший ни одного вызова и не получивший ни одного напоминания, в метрики
    // не попадал вовсе — то есть самый тяжёлый исход выглядел как отсутствие трения, а
    // приписка в постмортеме обещала читателю строку «Вызовов: 0», которой не бывало.
    if (!this.friction.has(stage)) this.friction.set(stage, EMPTY_FRICTION());

    const produced = def.produces(this.ctx);
    const missingBefore = missingNow(produced);
    const seeded = seedArtifacts(produced, this.config.runner.methodologyDir);
    this.seeded = seeded.map((s) => s.path);

    // Механические поля журнала chunk'а (номер, base_sha, бюджет попыток, даты) заполняет
    // рантайм ДО модели: замер серии r2 показал, что слабая модель с идеальным кодом
    // сжигает лимит ходов ровно на этих полях. Снимок после подстановки уходит в
    // `SeededArtifact.snapshot` — страж «бланк байт-в-байт» сравнивает с ним, и этап,
    // не сделавший ничего, по-прежнему виден.
    if (stage === 'chunk') await autofillJournal(this.host, seeded);
    // «Ветка витка» — та же логика: рантайм знает ответ детерминированно (git-дерево),
    // модели гадать не о чем. Только на intent — это единственный этап, где поле ещё не
    // заполнено (`branchMismatchBlocker` сверяет его на входе plan/chunk/verify/handoff).
    if (stage === 'intent') await autofillBranchField(this.host, seeded);

    // Отчёт приёмки: механику шапки и таблицу «Гейты» заполняет рантайм фактами только
    // что прогнанных гейтов — рецензенту остаются выводы и ревью. Замер r9: все
    // расхождения «отчёт/факт» дешёвого рецензента были в переписанной от себя таблице.
    if (stage === 'verify') autofillVerification(this.host, seeded);
    // План, готовность и названия отчётов этапов 2–3 — тот же приём (`formAutofill.ts`).
    // Поля объявлены за рантаймом и модели больше не отдаются, поэтому закрываются здесь.
    if (stage === 'intent' || stage === 'explore' || stage === 'ask' || stage === 'plan') {
      await this.autofillMechanicalFields(stage, seeded);
    }

    // Что считается «этап ничего не произвёл»: файла нет ИЛИ он остался бланком байт в
    // байт. Без второй половины проверка стала бы самообманом — бланк кладёт сам рантайм.
    const notDone = (): string[] => [
      ...stillMissing(produced, missingBefore),
      ...untouchedSeeds(seeded),
      // Этап 6: бланк, тронутый одной правкой, «произведённым» не считается — сверка байт
      // в байт пропускала отчёт с зелёными статусами при нетронутом тексте пунктов и без
      // строк на половину листа задачи (замер 2026-09-08, локальный рецензент). Здесь
      // считается содержание по пунктам ЗАДАЧИ; оформление остаётся дозаполнению.
      ...(stage === 'verify' ? verifyGaps(this.host) : []),
    ];
    for (const path of this.seeded) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message: `форма разложена под артефакт ${path} — этап заполняет её, а не создаёт заново`,
      });
    }

    // Промпт пересобирается, когда есть что подклеить: иначе правка оператора и факты
    // прогона исключали бы друг друга. Правка человека при этом сохраняется — она
    // приходит отдельными полями `system`/`user`.
    const prompt =
      opts.prompt === undefined
        ? this.preparePrompt(stage, {
            ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
            ...(extra === undefined ? {} : { extra }),
          })
        : withExtra(opts.prompt, appended);
    if (opts.prompt !== undefined) {
      this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    }

    // `let`, не `const`: одобренный `request_scope_extension` дописывает `plan.md` на диске
    // и пересчитывает `ctx` из него же — без переприсвоения политика этого же прогона
    // видела бы старый `files_to_touch` до самого конца этапа, и одобренная человеком
    // правка всё равно отклонялась бы следующим же `Write` в тот же путь.
    let ctx = this.policyContext(stage);
    /** Вызовы субагента-рецензента, ждущие результата: по ним ставится факт ревью. */
    const pendingReviewer = new Set<string>();
    /** Команда bash по requestId — только для вызовов, дошедших до исполнения: `onToolResult`
     * знает исход, но не сам вызов, `recordBashResult` гейта нужны оба. */
    const pendingBash = new Map<string, string>();
    /**
     * Прогресс этапа 5 — ПРИНЯТЫЕ записи в дерево (Write/Edit, дошедшие до исполнения
     * без ошибки). До этого счётчика `progressSignal` передавался только этапу 6, и на
     * chunk третий одинаковый вызов подряд обрывал этап безусловно — даже когда между
     * повторами модель успела записать половину кода. `pendingWrites` — requestId
     * разрешённых записей: исход знает `onToolResult`, вид вызова — `onToolRequest`.
     *
     * ЯВНО: счётчик подключается ко ВСЕМ исполнителям этапа chunk, не только к `stepFill`
     * (`StepExecutor` его вообще не читает — у него свой ограничитель, `REPAIRS_PER_STEP`).
     * Отсрочка при повторе одинакового вызова, если с начала серии был хоть один принятый
     * вызов, — намеренное послабление антицикла и для обычного `LoopExecutor`, а не побочный
     * эффект правки под `stepFill`: причины откатывать его для НЕ-stepFill моделей нет —
     * критерий «есть реальный прогресс» не завязан на конкретный исполнитель.
     */
    const pendingWrites = new Set<string>();
    let acceptedWrites = 0;
    /**
     * Имена, под которыми у этого этапа объявлен независимый рецензент, — и только они.
     *
     * Пересечение объявленного этапом списка с реестром рецензентов, а не поиск подстроки
     * в имени: гейт минимальной пятёрки не может зажигаться от того, как модель назвала
     * вызванного агента. Пусто — рецензента этап не объявлял, и зажечь гейт нечем.
     */
    const reviewerNames = new Set(def.subagents.filter((n) => REVIEWER_AGENTS.includes(n)));

    const hooks: ExecHooks = {
      onText: (text) => this.emit({ type: 'assistant_text', runId: this.id, stage, text }),
      onThinking: (text) => this.emit({ type: 'thinking', runId: this.id, stage, text }),
      // Потолки размера — лента событий пишется на диск на каждый запрос, а вопрос шага несёт
      // план и файл целиком; разбору «что спросили и что ответили» хватает начала.
      onExchange: ({ question, answer }) =>
        this.emit({
          type: 'model_exchange',
          runId: this.id,
          stage,
          question: question.length > EXCHANGE_QUESTION_CHARS ? `${question.slice(0, EXCHANGE_QUESTION_CHARS)}…` : question,
          answer: answer.length > EXCHANGE_ANSWER_CHARS ? `${answer.slice(0, EXCHANGE_ANSWER_CHARS)}…` : answer,
        }),

      onToolRequest: async (call, meta) => {
        this.status = 'awaiting';
        try {
          const decision = await this.gate.request({
            runId: this.id,
            stage,
            requestId: meta.requestId,
            toolName: meta.toolName,
            rawInput: meta.rawInput,
            call,
            // Права вызывающего СУЖАЮТ права этапа, но никогда их не расширяют:
            // пересечение, а не подстановка. Вложенный субагент не может получить больше
            // этапа, а объявленный без права записи разведчик не получает `Write` только
            // потому, что модель его назвала.
            ctx: {
              ...ctx,
              allowedTools: ctx.allowedTools.filter((t) => meta.callerTools.includes(t)),
            },
          });
          // Рецензентом считается ровно тот субагент, чьё определение этап объявил и
          // рантайм прочитал с диска. Подстрока «reviewer» в имени этой планкой не
          // является: модель, вызвавшая несуществующего `code-reviewer-helper`, получала
          // отказ загрузки — и всё равно зажигала гейт минимальной пятёрки.
          if (decision.allowed && call.kind === 'subagent' && reviewerNames.has(call.agent)) {
            pendingReviewer.add(meta.requestId);
          }
          // Прогресс — правка вне артефактов витка: правка журнала chunk'а в `.sdlc`
          // гасила напоминание о нулевом прогрессе ровно в том случае, под который оно
          // заведено (журнал заполнен, код не тронут — серия v4, `ministral`/`security-bait`).
          // Путь — сырая строка модели: сравнивается тем же лексическим приведением, что у
          // политики (регистр диска, `..`, обратные слэши), иначе `src/../.sdlc/x` засчитывался.
          if (
            decision.allowed &&
            (call.kind === 'write' || call.kind === 'edit') &&
            !(
              relativizeWithin(this.ctx.paths.projectRoot, resolveUserPath(this.ctx.paths.projectRoot, call.path)) ?? ''
            ).startsWith(`${SDLC_DIR}/`)
          ) {
            pendingWrites.add(meta.requestId);
          }
          if (decision.allowed && call.kind === 'bash') {
            // `call.command` — то, что ПРЕДЛОЖИЛА модель, не обязательно то, что реально
            // исполнится: оператор мог поправить команду через approve-with-edit
            // (`decision.updatedInput`), и оба исполнителя (`SdkExecutor`/`LoopExecutor`)
            // запускают именно правленый ввод. `recordBashResult` считает повторы по
            // фактически исполненной команде — иначе три РАЗНЫЕ команды, которые оператор
            // одну за другой правил после провала, засчитывались бы как одна и та же.
            const effective =
              decision.updatedInput === null
                ? call
                : normalize(meta.toolName, decision.updatedInput as Record<string, unknown>);
            pendingBash.set(meta.requestId, effective.kind === 'bash' ? effective.command : call.command);
          }
          // Человек одобрил расширение scope — дописываем `plan.md` и пересчитываем `ctx`
          // из него ЖЕ, до возврата решения: следующий вызов этого же прогона (обычно —
          // Write в только что одобренный путь) обязан увидеть новый `files_to_touch`,
          // а не версию, посчитанную в начале этапа.
          if (decision.allowed && call.kind === 'request_scope_extension') {
            const note = `расширено на этапе ${stage} · ${decisionValue(this.config.runner.operator, new Date())} — ${call.reason}`;
            const planText = readArtifact(this.paths.plan).text;
            const updated = appendScopeExtension(planText, call.path, note);
            if (updated === null) {
              // Одобрение человека остаётся в силе (решение о том, что расширение —
              // хорошая идея, не отменяется), но САМ вызов инструмента не выполнен —
              // технически дописать план не удалось. Раньше здесь возвращался исходный
              // `decision` (allowed: true) без изменений, и модель получала текст «путь
              // добавлен — теперь можно писать» безусловно, хотя `ctx.planFiles` не
              // обновился и следующий Write в этот путь всё равно падал на planScope —
              // модель узнавала о провале только на попытке записи, без объяснения
              // противоречия. Честнее — отказать ЭТОМУ вызову сейчас, с причиной: тот же
              // канал (`decision.reason`), которым уже пользуется отказ политики.
              const message =
                `человек одобрил расширение scope на «${call.path}», но в plan.md не нашлась ` +
                `строка «Добавлено сверх разведки» — файл, видимо, правлен вручную не по форме. ` +
                `Путь НЕ добавлен в files_to_touch; поправь plan.md вручную или попроси ` +
                `человека сделать это, прежде чем повторять запрос.`;
              this.emit({ type: 'warning', runId: this.id, stage, message });
              const denied: Decision = { allowed: false, reason: message, by: 'policy' };
              return denied;
            }
            writeArtifact(this.paths.plan, updated);
            ctx = this.policyContext(stage);
          }
          return decision;
        } finally {
          this.status = 'running';
        }
      },

      onToolResult: (meta) => {
        this.countFriction(stage, 'toolCalls');
        // Гейт «Ревью независимым агентом» зеленеет только по факту состоявшегося
        // прогона рецензента, и вот он, этот факт: вызов дошёл до результата без ошибки.
        if (meta.ok && pendingReviewer.has(meta.requestId)) this.markReviewerRan();
        pendingReviewer.delete(meta.requestId);
        if (pendingWrites.has(meta.requestId)) {
          if (meta.ok) acceptedWrites += 1;
          pendingWrites.delete(meta.requestId);
        }

        const bashCommand = pendingBash.get(meta.requestId);
        if (bashCommand !== undefined) {
          this.gate.recordBashResult(this.id, bashCommand, meta.ok);
          pendingBash.delete(meta.requestId);
        }

        this.emit({
          type: 'tool_result',
          runId: this.id,
          stage,
          requestId: meta.requestId,
          ok: meta.ok,
          summary: meta.summary,
          durationMs: meta.durationMs,
          ...(meta.detail === undefined ? {} : { detail: meta.detail }),
        });
      },

      onAskHuman: async (call) => {
        if (call.kind !== 'ask_human') return {};
        this.status = 'awaiting';
        try {
          return await this.askGate.ask({ runId: this.id, stage, questions: call.questions });
        } finally {
          this.status = 'running';
        }
      },

      // Записи в отчёт этапа 6. Здесь только приём и проверка ссылки: в файл они попадут
      // одним `Write` после хода, обычным путём через политику и гейт.
      onRecord: (call) => acceptRecord(this.host, call),

      onUsage: (usage) => {
        const st = this.stageStats.get(stage);
        if (st !== undefined) st.usage = addUsage(st.usage, usage);
        this.totalUsage = addUsage(this.totalUsage, usage);
        // Валюта — маршрута ЭТОГО этапа: стоимость копится по валютам раздельно,
        // и гард маршрута сверяет потолок только со своей (см. `spentLedger.ts`).
        //
        // В бюджет идёт не всякий расход: `budgetStages` (стенд) сужает учёт до
        // измеряемых этапов. В `totalUsage` и в события расход попадает ВСЕГДА — счёт
        // прогона обязан быть полным, сужается только то, по чему гард рубит виток.
        if (countsTowardBudget(this.budgetStages, stage)) {
          this.spent.add(route.providerDef.currency ?? 'USD', usage.costUsd);
        }
        this.emit({ type: 'usage', runId: this.id, stage, usage, total: this.totalUsage });
      },

      onWarn: (message) => this.emit({ type: 'warning', runId: this.id, stage, message }),

      onFriction: (kind) => this.countFriction(stage, kind),
    };

    try {
      // Исполнитель создаётся ВНУТРИ try: `createProvider` бросает при отсутствии ключа
      // и на нереализованном маршруте, а к этому моменту уже отправлен `stage_started`,
      // выставлен статус `running` и — для этапа 6 — прогнаны все гейты, то есть сборка
      // и тест-сьют. Пока бросок случался снаружи, `finally` не отрабатывал: статус
      // навсегда оставался `running`, `stage_done` не приходил, и кнопка запуска в
      // интерфейсе не разблокировалась до перезагрузки страницы.
      // Слепой вывод листа (агент 2 этапа 2) — шаг РАНТАЙМА до создания исполнителя: конвейер
      // `exploreFill` забирает его итог из `exploreClaims` при конструировании.
      if (stage === 'explore' && usesExploreFill(route)) {
        await runClaimsBlind(this.host, route, this.ecosystemFor(stage));
      }

      const executor = this.executorFor(stage);

      // Независимое ревью — шаг РАНТАЙМА, идущий до хода модели этапа (тем же порядком,
      // что и автоматические гейты). Его текст приходит модели готовым блоком: ей остаётся
      // перенести находки в §2–§5 отчёта, а не догадаться позвать `Task`. Не состоялось —
      // `null`, и тогда всё как раньше: у модели остаётся собственный вызов субагента.
      // Рецензент: свободный ход субагента либо — на flow `loop` с `reviewFill` — конвейер
      // закрытых вопросов по хункам. Одно место выбора, чтобы гейт ревью и вход этапа
      // ставились по одному и тому же прогону.
      const reviewText =
        stage === 'verify'
          ? route.flow === 'loop' && route.reviewFill
            ? await runReviewFill(this.host, route)
            : await runReviewerDirectly(this.host, prompt, agents, hooks)
          : null;
      const stagePrompt = reviewText === null ? prompt : withExtra(prompt, reviewerBlock(reviewText));

      // R1.1: конвейер `reviewFill`, прошедший ПОЛНОСТЬЮ, закрывает разбор diff'а сам —
      // собственный ход модели читал бы тот же diff ещё раз, в одном большом запросе,
      // и ровно это не проходило по бюджету у моделей без ручки эффорта (Apriel-1.6-15B,
      // qwen3.8-27b: конвейер из коротких вопросов проходил целиком, а следующий за ним
      // свободный ход — нет; замеры 2026-09-08). §1 добирает `topUpClaims` (тоже короткими
      // вопросами, вызывается ниже независимо от этого пропуска), прочее оформление —
      // дозаполнение по полям (`route.formFill`, тоже короткими запросами). Неполный
      // конвейер (диффа нет, часть вопросов не отвечена) собственный ход НЕ пропускает —
      // тогда разбора не было вовсе, и заменить его нечем.
      //
      // `route.skipTurnAfterReviewFill` — а не автоматика по факту полного конвейера: на
      // быстрой модели (100 % GPU) пропуск хода делает этап МЕДЛЕННЕЕ (дозаполнение по
      // полям поле-за-полем дороже, чем несколько ходов агентного цикла с батчем правок,
      // замер 2026-09-08) — ручка нужна там, где измеренно помогает, не всем.
      const skipModelTurn =
        stage === 'verify' &&
        route.flow === 'loop' &&
        route.reviewFill &&
        route.skipTurnAfterReviewFill &&
        this.state.verify.reviewFillComplete;

      let result: StageResult = skipModelTurn
        ? {
            ok: true,
            finalText: reviewText ?? '',
            usage: emptyUsage(),
            note:
              'ход модели пропущен: reviewFill прошёл конвейер целиком — отчёт закрывается ' +
              'его записями, добором по пунктам приёмки и дозаполнением по полям, без второго ' +
              'свободного прохода по тому же diff\'у',
          }
        : await executor.run(
        {
          prompt: stagePrompt,
          cwd: this.project.projectRoot,
          model: route.model,
          allowedTools: this.toolsFor(stage),
          readOnlyDirs: this.readOnlyRoots,
          subagents: agents,
          mcp,
          // «Ход завершён» и «работа сделана» — разные утверждения, и второе проверяется
          // диском. Замечание даёт модели доделать в том же этапе, а не отчитаться пустым.
          finishGuard: () => {
            const missing = notDone();
            if (missing.length > 0) {
              return (
                `артефакт этапа не заполнен: ${missing.join(', ')}. Ход не закончен — ` +
                `открой файл, замени места «‹…›» своим содержимым и сохрани инструментом Edit.`
              );
            }
            // Полнота intent.md — здесь, а не только предусловием этапа 2. `notDone()`
            // выше видит только «файл тронут vs пустой бланк»: дозаполнение, тронувшее
            // intent.md и оставившее хотя бы одно место (вне законно пустой «Что придётся
            // тронуть»), уходило зелёным — до входа в `explore` СЛЕДУЮЩЕГО цикла, где
            // чинить уже некому (тот же класс потери, что карта разведки ниже; живой
            // разбор серии v5, 2026-09-14: 4 из 22 прогонов упёрлись ровно в это).
            if (stage === 'intent') {
              const problem = intentPlaceholderProblem(this.ctx);
              if (problem !== null) {
                return `${problem}. Замени оставшиеся места «‹…›» содержимым и сохрани инструментом Edit.`;
              }
            }
            // Фактичность карты кодовой базы — здесь, а не только предусловием этапа 3.
            // Пока она стояла лишь там, отчёт с сочинённым путём закрывал этап 2 «успешно»,
            // а виток умирал на входе в этап 3 — модель уже ушла, и чинить было некому
            // (живой прогон r32 сгорел так на ЧЕСТНОМ отчёте). Замечание в своём ходу —
            // тот же приём, которым страж требует заполнить бланк.
            if (stage === 'explore') {
              const problem = explorationPathProblem(this.ctx);
              if (problem !== null) {
                return (
                  `${problem}. Поправь карту: несуществующий путь либо убери, либо помечай ` +
                  `словом «новый» — файл, который предстоит создать, картой кодовой базы не является.`
                );
              }
            }
            // Разбор последствий — тем же приёмом и по той же причине, что карта разведки:
            // находка нужна модели в её собственном ходу. Предусловием этапа 5 она пришла бы
            // после ухода планировщика, а дописывать исход за него стало бы некому — кроме
            // самого исполнителя, которому решение человека не принадлежит.
            if (stage === 'plan') {
              // Пустой files_to_touch — раньше axisProblems: без адресов правки разбор
              // последствий по осям тоже не может ссылаться на реальные пути, но само по
              // себе отсутствие files_to_touch — более фундаментальная и более дешёвая в
              // проверке находка (см. filesToTouchProblem).
              const filesProblem = filesToTouchProblem(this.ctx);
              if (filesProblem !== null) return filesProblem;
              const problems = this.axisProblems();
              if (problems.length > 0) {
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
              }
            }
            return null;
          },
          // Спасение напечатанного артефакта: модель составила его правильно, но не
          // записала. Идёт тем же путём, что обычная запись — политика и гейт одобрения.
          salvageFromText: (text) => this.salvageFromText(text, produced, stage),
          maxTurns: this.maxTurnsFor(stage),
          maxBudgetUsd: this.project.maxBudgetUsd,
          spentUsdBefore: this.spent.spent(route.providerDef.currency ?? 'USD'),
          // Прогресс этапа 6 — принятые записи отчёта. Анти-цикл обрывает этап только
          // тогда, когда за серию повторов не прибавилось ничего: обрыв посреди
          // заполняемого отчёта терял работу, уже сделанную (и оплаченную) целиком.
          // На этапе 5 прогресс — принятые записи в дерево: модель, повторившая вызов
          // рядом с делом, не должна терять уже записанный код.
          ...(stage === 'verify'
            ? {
                progressSignal: () => this.state.verify.claimRecords.size + this.state.verify.findingRecords.length,
                // Совет по умолчанию в LoopExecutor зовёт Edit — на verify прогресс это
                // RecordClaim/RecordFinding, а Edit противоречит независимости ревью
                // (`CLAUDE.md` → «Этап 6…»; code-review-all, 2026-09-14).
                progressHint:
                  'переходи к записи находок инструментами RecordClaim/RecordFinding прямо ' +
                  'сейчас, бюджет ходов не резиновый.',
              }
            : stage === 'chunk'
              ? {
                  progressSignal: () => acceptedWrites,
                  // Без императива «Edit»: на задаче, где требуемое уже сделано, правка не
                  // нужна вовсе, и совет по умолчанию толкал модель портить готовый код.
                  progressHint:
                    'если правка кода нужна — делай её сейчас инструментом Edit; если требуемое ' +
                    'уже есть в коде — зафиксируй это в журнале и заверши этап.',
                }
              : {}),
          // Для режима заполнения по полям: где искать плейсхолдеры. Обычные исполнители
          // поле не читают.
          formArtifacts: produced,
          // Проактивное закрытие готового этапа (`docs/proposals/model-flow-improvements.md`
          // §1.3/§2.1): не на chunk — там журнал попытки может стать готовым раньше кода, и
          // раннее закрытие обрубило бы дописывание правок в дереве.
          closeOnFinalizeReady: stage !== 'chunk',
          // Ключ → путь для FillField — тот же список, что уже отдан политике
          // (`policyContext`); нужен исполнителю, чтобы разрешённый политикой вызов дошёл
          // до диска (LoopExecutor кладёт его в ToolContext, SdkExecutor — в свой MCP-сервер).
          stageArtifacts: this.stageArtifacts(stage),
          signal: this.aborter.signal,
        },
        hooks,
      );

      // Поклаймовый добор (`ModelDef.claimFill`): пункты, о которых модель не сказала
      // ничего, добираются по одному вопросу со срезом патча. ДО внесения записей —
      // добранное идёт в отчёт тем же путём, что записанное вручную.
      if (
        stage === 'verify' &&
        route.flow === 'loop' &&
        (route.claimFill || route.reviewFill) &&
        !this.aborter.signal.aborted
      ) {
        await topUpClaims(this.host, route, stagePrompt.system);
      }

      // Топ-ап осей плана (`ModelDef.planAxisFill`): оси, о которых секция «Последствия
      // шагов» ничего не сказала, добираются ОДНИМ запросом. До `finishGuard`'а этапа —
      // он увидит меньше проблем, если топ-ап уже закрыл часть строк.
      if (
        stage === 'plan' &&
        route.flow === 'loop' &&
        route.planAxisFill &&
        !this.aborter.signal.aborted
      ) {
        await topUpAxes(this.host, route, stagePrompt.system);
      }

      // Записи рецензента вносятся в отчёт ДО дозаполнения по полям и до ансамбля:
      // дозаполнение считает оставшиеся плейсхолдеры, а маршруты ансамбля снимают копию
      // канонического отчёта — оба обязаны видеть уже внесённые пункты и находки.
      if (stage === 'verify') await applyRecords(this.host);

      // Дозаполнение журнала chunk'а по полям (`ModelDef.formFill` у модели этапа 5):
      // серия r5 показала конструкционный провал — модель с идеальным кодом 7 прогонов
      // подряд не закрывала этап, дочищая журнал инструментами до конца лимита ходов.
      // Содержательные поля добираются per-field completion'ами тем же FormFillExecutor,
      // запись идёт через тот же гейт; этап закрывается ТОЛЬКО если исполнитель упал
      // именно на оформлении и после дозаполнения на диске всё на месте.
      // Тот же механизм — и для отчёта приёмки (замер r9: рецензенту 14B при лимите 40
      // не хватало ходов именно на оформление отчёта). До ансамбля: дополнительные
      // маршруты снимают копию канонического отчёта, и она обязана быть полной.
      const formFinishPath =
        stage === 'chunk'
          ? this.paths.chunkJournal(this.chunk)
          : stage === 'verify'
            ? this.paths.verificationReport(this.chunk, this.attempt)
            : // Разведка — с 2026-09-04. Раньше её здесь не было потому, что этап сгорал
              // не на оформлении: живой прогон показал, как модель тратила ход на
              // ПРОДУКТОВЫЙ КОД (это закрыто политикой: до плана запись сужена до
              // артефактов витка). После починки картина другая — 25 ходов уходят на сам
              // отчёт, и этап падает с «исчерпан лимит ходов» при 17 незаполненных местах,
              // то есть ровно в `closableFailure`, ради которого добор и заведён.
              //
              // Заменить исполнителя целиком (`FORM_FILL_STAGES`) здесь нельзя и не нужно:
              // у `FormFillExecutor` нет ни `Read`, ни `Task`, а разведка без чтения кода —
              // это отчёт о том, что придётся тронуть, написанный по воображению. Добор
              // идёт ПОСЛЕ хода: инструменты у разведки остаются, рантайм снимает с неё
              // только цену оформления бланка.
              stage === 'explore'
              ? this.paths.explorationReport
              : null;
      // В режиме по шагам (`stepFill`) журнал chunk'а исполнитель не пишет по построению:
      // дозаполнение по полям идёт с отчётом о шагах во входе — иначе поля «что сделано»
      // заполнялись бы по памяти, которой у режима нет. Но только если хоть один шаг дал
      // правку: журнал этапа, в котором не записано ничего, не стоит двенадцати запросов —
      // он всё равно красный по дереву.
      const stepMode = stage === 'chunk' && route.stepFill;
      const stepProduced = stepMode && /применено [1-9]/.test(result.note);
      // Отчёт о шагах — артефакт попытки: причина красного шага иначе остаётся только в
      // консоли, и разбор прогона восстанавливает её по дереву (bench, stepfill-v2).
      if (stepMode && result.finalText !== '') {
        writeArtifact(this.paths.chunkSteps(this.chunk, this.attempt), `${result.finalText}\n`);
      }
      // В режиме `exploreFill` дозаполнение уже внутри конвейера (вложенным
      // `FormFillExecutor` со `skipFields`) — второй проход здесь переспрашивал бы поля.
      if (
        formFinishPath !== null &&
        route.flow === 'loop' &&
        (route.formFill || stepProduced) &&
        !(stage === 'explore' && usesExploreFill(route)) &&
        !this.aborter.signal.aborted
      ) {
        result = await this.finishFormArtifact(
          stage,
          formFinishPath,
          result,
          // Тот же промпт, что видел основной ход, — на этапе 6 он включает блок с
          // отчётом рецензента. Дозаполнение по полям без него добирало бы поля §2–§5
          // «по памяти», не зная о находках, ради которых этап и существует. В режиме по
          // шагам сюда же подклеивается отчёт о шагах — второй блок, которого нет в
          // промпте из `prompt_prepared`: как и блок рецензента, он факт рантайма, а не
          // правка за спиной оператора.
          stepProduced && result.finalText !== '' ? withExtra(stagePrompt, result.finalText) : stagePrompt,
          hooks,
          notDone,
          this.aborter.signal,
          () => acceptedWrites > 0 || stepProduced,
        );
      }

      if (stage === 'verify') await runEnsembleReviewers(this.host, prompt, def, agents, hooks);

      // Отмена проверяется ДО записи улик. Иначе отменённый этап затирал патч предыдущего
      // состояния снимком наполовину сделанного дерева (а при прерванном сигнале git
      // отдаёт пустой вывод, то есть улика подменялась ложным «правок нет») и запускал
      // тест-сьют, который уже некому ждать.
      const cancelled = this.aborter?.signal.aborted === true;

      // Свидетельства попытки — патч и запись о тестах — производит рантайм, перезаписывая
      // то, что записал агент. Иначе вход этапа 6 остаётся рассказом исполнителя о самом
      // себе; замер поймал ровно этот случай (см. `evidence.ts`).
      if (stage === 'chunk' && !cancelled) {
        this.state.chunk.tree = await recordEvidence(this.host, diffBefore);

        // Честность доказательств: журнал утверждает «тесты прогнаны и прошли» — в ленте
        // обязан быть успешный bash-вызов команды тестов. Расхождение раньше было видно
        // только в отчёте бенчмарка после прогона; оператор витка обязан видеть его здесь,
        // до вердикта (порт щупа `bench/src/honesty.ts`).
        const journal = readArtifact(this.paths.chunkJournal(this.chunk));
        if (journal.exists) {
          const honesty = checkJournalClaimsVsBash(
            journal.text,
            this.attemptToolEvents,
            this.attemptObservedFromStart,
          );
          if (honesty.ok === false) {
            this.emit({
              type: 'warning',
              runId: this.id,
              stage,
              message: `честность журнала: ${honesty.detail}`,
            });
          }
        }
      }

      this.reportArtifacts(stage);

      if (cancelled) {
        this.status = 'cancelled';
        const note = 'этап отменён оператором';
        this.emit({ type: 'stage_done', runId: this.id, stage, ok: false, note });
        return { ...result, ok: false, note };
      }

      // Вердикт считается сразу после этапа 6 — по отчёту, который только что записан,
      // и по прогону гейтов, который был до ревью. Отдельной кнопки у него нет: вердикт,
      // который надо не забыть посчитать, рано или поздно не считают.
      if (stage === 'verify') {
        // Сверку патча с деревом делает рантайм и делает её ЗДЕСЬ — после ревью, но до
        // подсчёта вердикта: раньше это условие держалось на фразе рецензента (r31).
        this.state.verify.diffFactMatchesTree = await diffStillMatchesTree(this.host);
        this.computeStageVerdict(this.detectNoProgress());
      }

      // Последнее слово об исходе — за диском, а не за исполнителем. Модель, объявившая
      // ход завершённым и не записавшая ни одного из объявленных этапом артефактов,
      // прошедшим этап не считается: во флоу `loop` она уже получила два напоминания, а
      // во флоу `sdk` цикл крутит харнесс, и другого места для этой проверки нет.
      const missingAfter = notDone();
      const failedSilently = result.ok && missingAfter.length > 0;
      // Пустое дерево после этапа 5 — самостоятельный провал, наравне с незаполненным
      // артефактом: свидетельства теперь кладёт рантайм, то есть «файлы на месте» перестало
      // быть признаком сделанной работы. `unknown` роняет этап по той же причине — состояние
      // дерева неизвестно, и считать его успехом значит зеленеть на непроверенном.
      const treeProblem =
        result.ok && stage === 'chunk' && this.state.chunk.tree !== 'changed'
          ? this.state.chunk.tree === 'empty'
            ? 'этап закончился, но дерево не изменилось: правки не было'
            : 'этап закончился, но состояние дерева неизвестно: свидетельства попытки не записаны'
          : null;
      const outcome = failedSilently
        ? {
            ...result,
            ok: false,
            note: `этап закончился, но артефакт не заполнен: ${missingAfter.join(', ')}`,
          }
        : treeProblem !== null
          ? { ...result, ok: false, note: treeProblem }
          : result;

      this.status = outcome.ok ? 'done' : 'failed';
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: outcome.ok, note: outcome.note });
      return outcome;
    } catch (e) {
      const message = (e as Error).message;
      this.status = 'failed';
      this.gate.cancelRun(this.id, `этап оборван: ${message}`);
      this.askGate.cancelRun(this.id);
      this.emit({ type: 'error', runId: this.id, stage, message });
      // Отказ среды называется признаком, а не только текстом: обычный цикл (LoopExecutor)
      // поднимает ошибку провайдера сюда целиком, и без этого прогон, где апстрим не
      // ответил, был бы неотличим от прогона, где модель не справилась.
      return {
        ok: false,
        finalText: '',
        usage: emptyUsage(),
        note: message,
        ...(e instanceof ProviderEnvError ? { envFailure: message } : {}),
      };
    } finally {
      stat.durationMs += Date.now() - stageStartedAt;
      this.aborter = null;
      // Снапшот после КАЖДОГО этапа: виток переживает пересоздание `Run`, и метрики
      // обязаны переживать его вместе с ним.
      this.writeMetricsSnapshot();
    }
  }

  /** Детект «нет прогресса» (`stages/chunk/evidence.ts::compareAttemptDiffs`); ставит близость патчей для интерфейса. */
  detectNoProgress(): boolean {
    const { same, closeness } = compareAttemptDiffs(this.paths, this.chunk, this.attempt);
    this.state.verify.closeness = closeness;
    return same;
  }

  /** Близость патча к патчу прошлой попытки. `null` — первая попытка или сравнивать нечего. */
  get progressCloseness(): number | null {
    return this.state.verify.closeness;
  }

  /** Сообщает о произведённых артефактах и о том, сколько мест в них осталось незаполненными. */
  private reportArtifacts(stage: StageId): void {
    for (const path of stageById(stage).produces(this.ctx)) {
      const a = readArtifact(path);
      if (!a.exists) continue;
      this.emit({
        type: 'artifact_written',
        runId: this.id,
        stage,
        path,
        placeholders: a.placeholders,
      });
    }
  }
}
