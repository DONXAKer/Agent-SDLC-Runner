/**
 * Машина витка: один прогон одного этапа за раз.
 *
 * Состояние живёт на диске, в `.sdlc/<slug>/` целевого проекта, а не в памяти процесса.
 * Поэтому предусловия проверяются чтением файлов: виток переживает перезапуск сервиса,
 * а начатый в терминале скиллами `/sdlc-*` продолжается здесь и наоборот.
 */

import { localResultBytes } from '../config/limits.ts';
import {
  isPreparationV2,
  approvePreparation,
  preparationReviewProblem,
  preparationFingerprint,
  preparation,
  recordPreparationRead,
  preparationExploreEvidenceProblem,
} from '../artifacts/preparation.ts';
import { seedPreparationForms } from './preparationForms.ts';
import { preparationTools } from './preparationToolPolicy.ts';
import { recordModelAnswers } from './stages/ask.ts';
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

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import {
  DECISION,
  branchNameFromField,
  decisionValue,
  DecisionFormError,
  artifactExists,
  countPlaceholdersExceptDecisions,
  hasNamedInvariants,
  readArtifact,
  readDecision,
  readField,
  setDecision,
  setLastDecision,
  writeArtifact,
} from '../artifacts/artifact.ts';
import { checkTemplateVersion } from '../artifacts/templateVersion.ts';
import { SDLC_CONSTANTS } from '../config/constants.ts';
import { SDLC_DIR, WitokPaths, artifactPathOf, isArtifactKey } from '../artifacts/paths.ts';
import { ARTIFACT_KEYS as ARTIFACT_KEYS_ALL, type ArtifactKey } from '@sdlc-runner/shared';
import { appendScopeExtension, extractFilesToTouch } from '../artifacts/planFiles.ts';
import { h2SectionRanges } from '../md/table.ts';
import type { AskGate } from '../approval/askGate.ts';
import { repairErasedDecisions } from '../approval/destructive.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import { isWindowsStyle, pathsEqual, relativizeWithin, resolveUserPath } from '../policy/paths.ts';
import type { LoadedConfig } from '../config/load.ts';
import { EMPTY_MCP, rulesForStage } from '../config/mcp.ts';
import { effectiveMode } from '../policy/mcp.ts';
import { missingNow, seedArtifacts, stillMissing, untouchedSeeds } from './seed.ts';

function isRuntimeOwnedSeed(stage: StageId, path: string): boolean {
  return stage === 'intent' && basename(path) === 'readiness.md';
}
import { countsTowardBudget, SpentLedger } from './spentLedger.ts';
import type { McpSetup } from '../config/mcp.ts';
import { McpHub } from '../mcp/McpHub.ts';
import { imageSaver } from '../mcp/content.ts';
import { estimateTokens, selectTools } from '../mcp/select.ts';
import type { McpToolInfo } from '../mcp/types.ts';
import { historyBudgetFor } from '../exec/contextBudget.ts';
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
  ExecRequest,
  FrictionKind,
  McpAccess,
  StageExecutor,
  StageResult,
} from '../exec/StageExecutor.ts';
import { REVIEWER_AGENTS } from '../exec/StageExecutor.ts';
import { loadSubagents } from '../exec/subagents.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { gateKey } from '../gates/gatesFile.ts';
import { readGatesCached } from '../gates/gatesCache.ts';
import { describeBuild } from '../gates/builtin/index.ts';
import { currentBranch, isRepo } from '../gates/git.ts';
import { runGateByName } from '../gates/run.ts';
import { git, hasCommits } from '../gates/git.ts';
import { autofillClarification, autofillPlan, autofillReadiness, autofillTitle } from './formAutofill.ts';
import { claimIdOf } from '../artifacts/claims.ts';
import { salvageBlocks } from './salvage.ts';
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
import { appendIteration, parseIterations, readIterationsText } from './iterationsLog.ts';
import { postmortemBlock } from './postmortem.ts';
import { metricsBlock } from './metricsReport.ts';
import { ProviderEnvError } from '../provider/ChatProvider.ts';
import { suggestEscalation } from './escalation.ts';
import { applyEnvRetryBudget, envRetryBudget, envRetryCount } from './envRetryBudget.ts';
import type { Escalation } from './escalation.ts';
import { buildPrompt } from '../prompt/build.ts';
import {
  checkPreconditions,
  hasOpenQuestions,
  relOf,
  stageById,
  type PreconditionReport,
  type StageContext,
  type StageDef,
} from './stages.ts';
import { ChunkState } from './stages/chunk/index.ts';
import { stepFillExecutor } from './stages/chunk/steps.ts';
import { guidedExecutor } from './guidedExecutor.ts';
import { GuidedAskExecutor } from '../exec/GuidedAskExecutor.ts';
import { GuidedPlanExecutor } from '../exec/GuidedPlanExecutor.ts';
import { accountGuidedTime, initGuided, readGuided } from './guidedState.ts';
import { decideReviewScan, routeKey } from './reviewRoute.ts';
import type { ReviewScanDecision } from './reviewRoute.ts';
/** Реэкспорт: тесты и прежние импорты берут выбор гейтов шага отсюда. */
export { gatesForStep, pickStepFailure, plannedDependencyBlocker, plannedSameFileFollowup, plannedTestFollowup } from './stages/chunk/steps.ts';
/** Реэкспорт: тесты берут блок рецензента для входа этапа 6 отсюда. */
export { reviewerBlock } from './stages/verify/reviewer.ts';
import { compareAttemptDiffs, readBaseline, runNamedGate } from './stages/chunk/evidence.ts';
import { restoreAttemptFromJournal, restoreChunkFromDir } from './stages/chunk/restore.ts';
import { normalizeMetrics, readMetricsRaw } from './metricsSnapshot.ts';
import { entryProblems, planFilesOnDisk } from './stages/entry.ts';
import {
  ExploreState,
  exploreFillExecutor,
  exploreIndexFor as exploreIndexOf,
  usesExploreFill,
} from './stages/explore.ts';
import { stageModule } from './stages/index.ts';
import type { CommitOutcome } from './commitByRuntime.ts';
import { axesGateRow as axesGateRowOf, axisProblems as axisProblemsOf } from './stages/plan.ts';
import { ensureIntentSnapshot } from './stages/intent.ts';
import type { StageHost } from './stages/types.ts';
import { VerifyState } from './stages/verify/state.ts';
import {
  earlyGateRows as earlyGateRowsOf,
  earlyGatesForModel,
  gateResultsForVerdict,
  runVerifyGates as runVerifyGatesOf,
} from './stages/verify/gates.ts';
import {
  acceptRecord,
  evidenceHaystack,
} from './stages/verify/records.ts';
import { retryDetail, stageVerdict } from './stages/verify/verdict.ts';
import { readRunVerdict, stalePatchReason } from './verdictStore.ts';

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
  executionMode?: 'legacy' | 'guided';
  prompt?: PreparedPrompt;
  requirement?: string;
  /** Только для нового витка: v3 по умолчанию; v1/v2 остаются для воспроизводимости. */
  preparationVersion?: 1 | 2 | 3;
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

/**
 * Пересчёт стража завершения после доборов рантайма (`afterTurn`).
 *
 * Пересчитываются два класса провала:
 *  - находка стража этапа (`note` совпадает с последней выданной `stageProblem`) — добор
 *    мог закрыть именно её; оставшиеся находки идут в заметку свежим текстом;
 *  - провал на ОФОРМЛЕНИИ (`isFormattingFailure`: лимит ходов, обрезка длины, застревание
 *    финализации) при полностью заполненных артефактах (`formComplete`) — тот же случай,
 *    что спасает `finishFormArtifact`: слабая модель сожгла ходы на таблице осей, добор её
 *    закрыл. Здесь провал снимается, только если страж молчит; иначе исходная причина
 *    остаётся — добор её не отменил.
 * Бюджет, отказ политики, анти-цикл повтора остаются провалом со своей причиной. Прежде
 * условие смотрело лишь на `!ok`, и план, упёршийся в бюджет при молчащем страже,
 * становился зелёным, а причина провала затиралась (code-review-all 2026-09-23).
 * Пересчёт — полным стражем, тем же, что видел исполнитель: добор мог и испортить форму.
 * Закрытие помечается `closedBy: 'runtime'` — в отчёте bench это заслуга рантайма, не модели.
 */
export function recheckGuardAfterTopUp(
  result: StageResult,
  stageProblem: string | null,
  guard: () => string | null,
  formComplete: () => boolean = () => false,
): StageResult {
  if (result.ok || result.envFailure !== undefined) return result;
  const guardFailure = stageProblem !== null && result.note === stageProblem;
  const formatting = !guardFailure && isFormattingFailure(result.note) && formComplete();
  if (!guardFailure && !formatting) return result;
  const afterTopUp = guard();
  if (afterTopUp === null) {
    const note = guardFailure
      ? 'страж завершения этапа закрыт добором рантайма после хода модели'
      : `${result.note} — этап закрыт: доборы рантайма довели артефакт, страж завершения молчит`;
    return { ...result, ok: true, note, closedBy: 'runtime' };
  }
  return guardFailure ? { ...result, note: afterTopUp } : result;
}


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

/** Обрезка по длине без разреза суррогатной пары: одиночный суррогат уходил в ленту и в UI как «�». */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/**
 * Путь модели лежит в `.sdlc/` проекта — тем же лексическим приведением, что у политики,
 * включая регистр: на Windows `.SDLC/<slug>/…` — тот же файл журнала, и сравнение с учётом
 * регистра засчитывало его правку в прогресс кода.
 */
function inSdlcDir(root: string, userPath: string): boolean {
  const rel = relativizeWithin(root, resolveUserPath(root, userPath)) ?? '';
  return pathsEqual(rel.slice(0, SDLC_DIR.length + 1), `${SDLC_DIR}/`, isWindowsStyle(root));
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
  private verdictCycle = randomUUID();
  private recordedVerdictCycle: string | null = null;
  readonly project: ProjectConfig;
  readonly profile: ResolvedProfile;
  readonly slug: string;
  readonly paths: WitokPaths;

  chunk = 1;
  attempt = 1;
  private currentStatus: RunStatus = 'idle';
  awaitingSince: number | null = null;

  get status(): RunStatus { return this.currentStatus; }
  set status(value: RunStatus) {
    if (value === 'awaiting' && this.currentStatus !== 'awaiting') this.awaitingSince = Date.now();
    if (value !== 'awaiting') this.awaitingSince = null;
    this.currentStatus = value;
  }
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
   * Отмена пришла, пока этап ещё не создал `aborter` (проба среды verify, сверка ветки):
   * `abort()` было не на чем вызвать, и этап после этого исполнялся целиком. Флаг
   * взводит `cancel`, а `runStage` гасит свежий `aborter` сразу (code-review-all 2026-09-23).
   */
  private cancelRequested = false;
  /**
   * Состояние этапов, живущее между вызовами: записи и вердикт попытки этапа 6, кэш индекса
   * и слепой лист разведки, дерево попытки chunk. Владелец — виток; объяснения полей — в
   * классах состояния модулей этапов (`stages/verify/state.ts`, `stages/explore.ts`,
   * `stages/chunk/index.ts`).
   */
  private readonly state: { readonly verify: VerifyState; readonly explore: ExploreState; readonly chunk: ChunkState } = { verify: new VerifyState(), explore: new ExploreState(), chunk: new ChunkState() };

  /**
   * Итог последнего `commitByRuntime` за текущий вход в этап `handoff` — мост между
   * `afterStart` (делает коммит) и `mechanicalJobs` (заполняет строку `commit:` отчёта),
   * которые видят РАЗНЫЕ объекты `this.host` (геттер пересоздаёт литерал на каждый вызов),
   * но оба читают/пишут это одно поле экземпляра `Run` (ревью code-review-all, 2026-09-19).
   */
  private lastCommitOutcome: CommitOutcome | null = null;

  /**
   * Текущий вход в этап — обрыв витка (`RunStageOptions.abortHandoff`): `mechanicalJobs`
   * зовутся и из `finishFormArtifact`, куда опции входа не доезжают, — тот же мост, что выше.
   */
  private currentAbortHandoff = false;

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
      baseSha: () => this.baseSha(),
      commitOutcome: () => this.lastCommitOutcome,
      recordCommitOutcome: (outcome) => {
        this.lastCommitOutcome = outcome;
      },
      gatesFile: () => this.gatesFile,
      intentClaimLines: (intentText) => this.intentClaimLines(intentText),
      policyContext: (stage) => this.policyContext(stage),
      trace: (stage, mode) => this.trace(stage, mode),
      accountOffPathUsage: (stage, usage, currency) => this.accountOffPathUsage(stage, usage, currency),
      syntheticRequestId: (prefix) => `${prefix}-${this.salvageSeq++}`,
      requestApproval: (req) => this.gate.request(req),
      askHuman: async (stage, questions) => {
        // Тот же переход статуса, что и у модельного `onAskHuman` (ниже по файлу): без
        // него `run.status` остаётся `'running'` на всё время ожидания ответа человека, и
        // бейдж интерфейса показывает «этап идёт» вместо «ждёт человека» ровно там, где
        // ответ оператора действительно нужен прямо сейчас (ревью code-review-all,
        // 2026-09-19).
        this.status = 'awaiting';
        try {
          return await this.askGate.ask({ runId: this.id, stage, questions: [...questions] });
        } finally {
          this.status = 'running';
        }
      },
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
      executorFor: (stage, route, preparationForms) => this.executorFor(stage, route, preparationForms),
      mcpAccess: (stage) => this.mcpAccess(stage),
      maxTurnsFor: (stage) => this.maxTurnsFor(stage),
      readOnlyRoots: () => this.readOnlyRoots,
      maxBudgetUsd: this.project.maxBudgetUsd,
      spentBefore: (currency) => this.spent.spent(currency),
      verifyRoute: () => this.profile.routes.verify,
      reviewScan: () => this.reviewScanRoute(),
      ensembleRoutes: () => this.profile.ensemble.verify ?? [],
      metrics: () => this.metrics,
      resetAttemptState: () => this.resetAttemptState(),
      ctx: () => this.ctx,
      attemptToolEvents: () => this.attemptToolEvents,
      attemptObservedFromStart: () => this.attemptObservedFromStart,
      chunkState: this.state.chunk,
      detectNoProgress: () => this.detectNoProgress(),
      computeStageVerdict: (noProgress) => this.computeStageVerdict(noProgress),
      beginVerification: () => { this.verdictCycle = randomUUID(); },
      profile: () => this.profile,
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
  private readonly stageStats = new Map<
    StageId,
    { runs: number; usage: Usage; durationMs: number; requestDurationsMs: number[] }
  >();
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
  /** Чей расход копится в бюджет (`RunOptions.budgetStages`). `null` — все этапы. */
  private readonly budgetStages: ReadonlySet<StageId> | null;

  constructor(o: RunOptions) {
    this.config = o.config;
    this.project = o.project;
    this.profile = structuredClone(o.profile);
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
    // Служебные файлы раннера (`.runner/`) — состояние этой машины, не артефакты
    // методологии: каталог игнорируется git'ом сам, чтобы после коммита handoff дерево не
    // оставалось грязным (ревью). Ошибка записи не роняет виток.
    try {
      const ignore = join(this.paths.runnerDir, '.gitignore');
      if (!existsSync(ignore)) {
        mkdirSync(this.paths.runnerDir, { recursive: true });
        writeFileSync(ignore, '*\n', 'utf8');
      }
    } catch {
      /* наблюдаемость, не условие корректности */
    }
    this.mcpSetup = o.config.mcp.get(o.project.name) ?? EMPTY_MCP;
    this.hub = new McpHub(this.mcpSetup.servers);
    this.chunk = restoreChunkFromDir(this.paths.dir) ?? this.chunk;
    this.attempt = restoreAttemptFromJournal(this.paths.chunkJournal(this.chunk)) ?? this.attempt;
    // Журнал хранит номер ПОСЛЕДНЕЙ начатой попытки, и виток остаётся на ней, каким бы ни
    // был её вердикт. Сдвиг за красной попыткой при восстановлении обходил `/advance`:
    // после `escalate` получалась «попытка 4 из 3», после `blocked_env` — попытка без патча,
    // на которой verify повторить нельзя (code-review-all 2026-09-23). Улики отвергнутой
    // попытки (живой виток ta-13) бережёт предусловие chunk, а не номер: следующая попытка
    // начинается «Новой попыткой», которая проверяет бюджет.
    //
    // Вердикт попытки восстанавливается с диска (`verdictStore.ts`): по нему `nextAttempt`
    // решает, растёт ли номер (после `blocked_env` — нет: та же K).
    const restored = readRunVerdict(this.paths, this.chunk, this.attempt);
    this.state.verify.verdict =
      restored === null ? null : { passed: restored.passed, action: restored.action, reasons: restored.reasons };
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
        requestDurationsMs: v.requestDurationsMs,
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
    // Формат и места файла знает один читатель (`metricsSnapshot.ts`) — его же зовёт дашборд.
    const r = readMetricsRaw(this.paths);
    if (r === null) return;
    const m = normalizeMetrics(r.raw);

    for (const s of m.stages) {
      this.stageStats.set(s.stage, {
        runs: s.runs,
        usage: s.usage,
        durationMs: s.durationMs,
        requestDurationsMs: s.requestDurationsMs,
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
    if (r.spent !== null) this.spent.restore(r.spent);
    this.verdictCount = m.verdicts.total;
    this.redCount = m.verdicts.red;
    this.redByCause.clear();
    for (const c of m.redByCause) this.redByCause.set(c.kind, c.count);
    this.attemptsByChunk.clear();
    for (const c of m.attemptsByChunk) this.attemptsByChunk.set(c.chunk, c.attempts);
    this.friction.clear();
    for (const f of m.friction) {
      const { stage, ...counters } = f;
      this.friction.set(stage, { ...EMPTY_FRICTION(), ...counters });
    }
    this.gateAgg.clear();
    for (const g of m.gates) this.gateAgg.set(g.gate, g);
    this.humanAgg.clear();
    for (const h of m.human) {
      this.humanAgg.set(h.stage, { questions: h.questions, approvals: h.approvals, waitMs: h.waitMs });
    }
    this.artifactGapsByFile.clear();
    for (const g of m.artifactGaps) this.artifactGapsByFile.set(g.artifact, g.placeholders);
    this.chunkEvidenceAgg.clear();
    for (const e of m.chunkEvidence) this.chunkEvidenceAgg.set(`${e.chunk}:${e.attempt}`, e);
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
    const a = readIterationsText(this.paths);
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
      const existing = readIterationsText(this.paths);
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
    if (readGuided(this.paths)) return { kind: 'none', why: 'guided закрепляет одну модель; при неудаче требуется пересмотр задачи или плана' };
    // Escalate above the strongest chunk route so a retry can change models.
    const chunkRoutes = this.profile.ensemble.chunk ?? [this.profile.routes.chunk];
    const chunk = chunkRoutes.reduce((a, b) => (a.rank >= b.rank ? a : b), this.profile.routes.chunk);
    return suggestEscalation({
      failedClaimsByAttempt: this.failedClaimsByAttempt,
      chunkModelId: chunk.modelId,
      chunkRank: chunk.rank,
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
    preparationFingerprint?: string;
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
    if (o.artifact === 'plan' && o.label === DECISION.approval && o.granted && isPreparationV2(this.paths)) {
      if (o.preparationFingerprint !== preparationFingerprint(this.paths)) throw new DecisionFormError('редакция проработки изменилась или не указана; перечитай требования и план перед подтверждением');
      const problem = preparationReviewProblem(this.paths);
      if (problem !== null) throw new DecisionFormError(problem);
    }

    const signature = decisionValue(this.config.runner.operator, new Date());
    const note = (o.note ?? '').trim();
    // Содержательная часть решения сохраняется: `setDecision` заменяет всё после метки,
    // и без этого запись «пропуск найден: claim-4 не покрыт» стиралась подписью.
    const value = o.granted
      ? note === ''
        ? signature
        : `${signature} — ${note}`
      : `**не одобрено** — ${note === '' ? 'причина не названа' : note} · ${signature}`;

    // Handoff ведёт секции по виткам, и подпись «Приёмка» ложится в ПОСЛЕДНЮЮ (`SDLC.md` →
    // «Раскладка артефактов»): первая «Приёмка» файла — прошлого витка той же задачи.
    const next = o.artifact === 'handoff' ? setLastDecision(current.text, o.label, value) : setDecision(current.text, o.label, value);
    writeArtifact(path, next);
    if (o.artifact === 'plan' && o.label === DECISION.approval && o.granted) {
      approvePreparation(this.paths, this.config.runner.operator, new Date());
    }
    // Одобрение плана снимает снимок секций задачи заново (`SDLC.md` → «Вердикт», восьмое
    // условие): дополнение листа по находке гейта этапа 4 к этому моменту сделано человеком,
    // и с этого момента задача снова неизменяема до конца витка.
    if (o.artifact === 'plan' && o.label === DECISION.approval && o.granted) {
      try {
        ensureIntentSnapshot(this.host, 'plan', {
          force: true,
          why: 'план одобрен — снимок секций задачи снят заново: до конца витка intent.md неизменяем',
        });
      } catch (e) {
        // Снимок — страховка этапов 4/6, не условие записи решения: отказ называется, а не роняет запись.
        this.emit({ type: 'warning', runId: this.id, stage: 'plan', message: `снимок секций задачи не снят: ${(e as Error).message}` });
      }
    }
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
    // Пустой путь (эталон не задан) корнем чтения не становится: он резолвился бы от cwd.
    const m = this.config.runner.methodologyDir;
    return [...(typeof m !== 'string' || m === '' ? [] : [`${m}/templates`, m]), this.config.runner.skillsDir].filter(
      (p) => typeof p === 'string' && p !== '',
    );
  }

  /**
   * Почему виток нельзя продвинуть — `null`, если можно. Решение по вердикту на ДИСКЕ
   * (переживает рестарт) и по бюджету попыток. Прежде `/advance` не проверял ничего:
   * «Новая попытка (4 из 3)» после эскалации, новая попытка поверх зелёной, двойной клик,
   * съедавший номер и диагноз прошлой попытки (code-review-all 2026-09-23).
   */
  advanceProblem(to: 'attempt' | 'chunk'): string | null {
    const verdict = readRunVerdict(this.paths, this.chunk, this.attempt);
    if (to === 'chunk') {
      // Зелёный, но уже не о текущем патче — следующий chunk лёг бы поверх непроверенного.
      return verdict?.passed === true
        ? stalePatchReason(this.paths, this.chunk, this.attempt, verdict)
        : `chunk ${this.chunk} не принят: следующий chunk — только после зелёного вердикта попытки ${this.attempt}`;
    }
    if (verdict === null || verdict.passed) {
      if (verdict?.passed) {
        const stale = stalePatchReason(this.paths, this.chunk, this.attempt, verdict);
        if (stale !== null) return stale;
      }
      return verdict !== null
        ? `попытка ${this.attempt} принята — новая попытка не нужна, дальше следующий chunk или передача`
        : `попытка ${this.attempt} ещё не проверена вердиктом этапа 6 — новая попытка поверх неё стёрла бы её диагноз`;
    }
    if (verdict.action === 'escalate') {
      const envFailures = envRetryCount(this.paths, this.chunk);
      if (envFailures > 0) {
        return `вердикт попытки ${this.attempt} — escalate: среда не восстановлена за ${envFailures} прогонов Verify подряд. ` +
          'Восстанови среду и повтори Verify; решение о продолжении — за человеком. ' +
          'Другие варианты: обрыв витка или правка строки «Бюджет средовых повторов» в .sdlc/gates.md и повтор Verify';
      }
      return (
        `вердикт попытки ${this.attempt} — escalate: решение за человеком — ` +
        'обрыв витка или правка бюджета в .sdlc/gates.md'
      );
    }
    return null;
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
    // Средовой красный не занимает номер попытки: `SDLC.md` («blocked_env в этот счёт не
    // входит») — следующий прогон после закрытия долга среды — та же попытка K, не K+1, а
    // журнал итераций получает вторую строку с тем же K. Улики попытки K при этом
    // перезаписываются заново из того же дерева: работа исполнителя живёт в дереве, а
    // «запись о тестах» блокированной попытки по построению говорит лишь «инструмента
    // нет» — терять там нечего. Прежняя схема (номер растёт, бюджет считается вычетом)
    // расходилась с журналом chunk'а терминальной сессии, где та же попытка — та же K.
    const blockedByEnv = readRunVerdict(this.paths, this.chunk, this.attempt)?.action === 'blocked_env';
    // После `blocked_env` выжимка «что не сошлось» адресована человеку/среде, не исполнителю
    // (`SDLC.md`: retry_instruction = «прогнать гейты в среде X») — в промпт chunk'а не идёт.
    if (blockedByEnv) this.carryForward = null;
    if (!blockedByEnv) this.attempt += 1;
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
    this.verdictCycle = randomUUID();
    this.state.verify.lastGateResults = [];
    this.state.verify.lastGatesAborted = false;
    this.state.verify.verdict = null;
    this.state.verify.lastVerdictInput = null;
    this.state.verify.redCause = null;
    this.state.verify.reviewerRan = false;
    // Факты попытки — тоже свойство ПОПЫТКИ: без сброса `reviewJson` попытки K уезжал бы в
    // `.chunk-N-attempt-(K+1)-review.json`, когда на K+1 ревью шло записями модели (ревью).
    this.state.verify.reviewJson = null;
    this.state.verify.reviewText = null;
    this.state.verify.evidenceFact = undefined;
    this.state.verify.intentTamperFact = undefined;
    this.state.verify.diffFactMatchesTree = null;
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
    // Кэш по времени правки и размеру — ОДИН на рантайм и дашборд (`gates/gatesCache.ts`):
    // один `GET /api/runs/:id` спрашивал набор семь раз, а два кэша одного файла с разными
    // ключами давали живой странице и дашборду разные блокеры.
    return readGatesCached(this.paths.gates);
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

  /** Бюджет попыток из набора гейтов, умолчание методологии — `sdlc-constants.json`. */
  get attemptBudget(): number {
    const DEFAULT = SDLC_CONSTANTS.attempt_default_budget;
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
    return planFilesOnDisk(this.ctx, stage);
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

  /** Блокер по версии формы существующих артефактов этапа; `null` — формы совпадают. */
  private templateVersionBlocker(stage: StageId, existing: readonly string[]): string | null {
    const dir = this.config.runner.methodologyDir;
    if (typeof dir !== 'string' || dir === '') return null;
    const problems: string[] = [];
    for (const path of existing) {
      const check = checkTemplateVersion(path, dir);
      if (check.kind === 'mismatch') {
        problems.push(
          `${path}: форма ${check.artifact.name} v${check.artifact.v}, а эталон — ${check.template.name} v${check.template.v}; ` +
            'артефакт снят другой версией формы — перенеси содержимое в новую форму или откати эталон',
        );
      } else if (check.kind === 'unversioned') {
        this.emit({
          type: 'warning',
          runId: this.id,
          stage,
          message: `${path}: у артефакта нет строки версии формы (эталон — ${check.template.name} v${check.template.v}); виток снят до её появления, сверка формы не делалась`,
        });
      }
    }
    return problems.length === 0 ? null : problems.join('\n');
  }

  /**
   * Маркеры терминального hook'а (`sdlc-guard.py`) в каталоге витка снимаются с
   * предупреждением: рантайм держит границу scope и замок ревью сам.
   */
  private clearGuardMarkers(stage: StageId): void {
    for (const name of ['.scope.json', '.review-lock', '.claims-lock']) {
      const p = join(this.paths.dir, name);
      if (!existsSync(p)) continue;
      try {
        unlinkSync(p);
        this.emit({
          type: 'warning',
          runId: this.id,
          stage,
          message: `снят маркер терминальной сессии ${name} из каталога витка: границу scope и замок ревью здесь держит рантайм`,
        });
      } catch (e) {
        this.emit({ type: 'warning', runId: this.id, stage, message: `маркер ${name} не снят: ${(e as Error).message}` });
      }
    }
  }

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
   * База diff'а витка — тем же источником, что у `attempt-evidence.py` методологии: поле
   * «База» плана (его пишет рантайм при одобрении, `autofillPlan`), затем «База» журнала
   * chunk'а (виток, начатый с chunk'а по снимку), затем HEAD. Патч попытки, сверка этапа 6
   * и терминальный инструмент обязаны считать diff от одного коммита — иначе сверка «патч
   * совпал с деревом» сравнивает разные вещи.
   */
  private async baseSha(): Promise<{ sha: string | null; source: 'plan' | 'journal' | 'head' | 'none'; why: string }> {
    const fromField = (text: string): string | null => {
      const v = readField(text, 'База');
      // Только голый sha первым словом: `/[0-9a-f]{7,40}/` по значению принимал дату
      // («2026-09-24» → «20260924») за базу, и `git diff` падал на этапе 5 (ревью).
      const m = v === null ? null : /^`?([0-9a-fA-F]{7,40})`?(?=\s|$)/.exec(v.trim());
      return m === null ? null : m[1]!;
    };
    const plan = readArtifact(this.paths.plan);
    const fromPlan = plan.exists ? fromField(plan.text) : null;
    if (fromPlan !== null) return { sha: fromPlan, source: 'plan', why: '' };
    const journal = readArtifact(this.paths.chunkJournal(this.chunk));
    const fromJournal = journal.exists ? fromField(journal.text) : null;
    if (fromJournal !== null) return { sha: fromJournal, source: 'journal', why: '' };
    const head = await this.head();
    return head.sha === null ? { sha: null, source: 'none', why: head.why } : { sha: head.sha, source: 'head', why: '' };
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
    // Задания — у модулей этапов (`StageModule.mechanicalJobs`); у chunk/verify их
    // нет, и повторный вызов из `finishFormArtifact` для них ничего не делает.
    const jobs = stageModule(stage).mechanicalJobs?.(this.host, this.currentAbortHandoff ? { abortHandoff: true } : {}) ?? [];

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
   * Учёт расхода для запросов ВНЕ `executor.run()` — `reviewFill`/`claimFill`/
   * `planAxisFill`/`exploreFill` зовут провайдера напрямую, минуя `hooks.onUsage`
   * (`Run.runStage`), и без этого метода их токены/стоимость были бы «бесплатными» для
   * `SpentLedger`/`maxBudgetUsd` и не попадали бы ни в `metrics.json`, ни в событие `usage`
   * — тот же учёт, тем же приёмом.
   *
   * `usage.durationMs` (провайдер ставит его на КАЖДЫЙ запрос, `emptyUsage()` — 0) идёт в
   * `requestDurationsMs` тем же приёмом, что и в основном хуке `onUsage` ниже — иначе
   * критерий 2 квалификации рецензента (`docs/proposals/reviewer-qualification.md`,
   * зависший запрос топит бюджет этапа) был бы слеп именно к `reviewFill` — пайплайну,
   * чьё зависание на `qwen3.6-27b-iq4` (2026-09-27) и стало поводом завести это поле
   * (найдено code-review-all в этой же сессии: без этой правки метрика не видела ни одного
   * запроса `reviewFill`/`claimFill`/`planAxisFill`/`exploreFill` вовсе).
   */
  private accountOffPathUsage(stage: StageId, usage: Usage, currency: string | undefined): void {
    const st = this.stageStats.get(stage);
    if (st !== undefined) {
      st.usage = addUsage(st.usage, usage);
      if (usage.durationMs > 0) st.requestDurationsMs.push(usage.durationMs);
    }
    this.totalUsage = addUsage(this.totalUsage, usage);
    if (countsTowardBudget(this.budgetStages, stage)) {
      this.spent.add(currency ?? 'USD', usage.costUsd);
    }
    this.emit({ type: 'usage', runId: this.id, stage, usage, total: this.totalUsage, offPath: true });
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
    codeChanged: () => boolean | Promise<boolean> = () => true,
    /** Проверка добранного артефакта, которую плейсхолдеры не видят (у explore — фактичность карты). */
    honesty: () => string | null = () => null,
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
      const problem = honesty();
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
      if (!fill.ok) {
        const withEnv =
          fill.envFailure === undefined || result.envFailure !== undefined
            ? result
            : { ...result, envFailure: fill.envFailure };
        // Причина остановки этапа не должна забывать, что рескью ВООБЩЕ запускался и
        // как далеко дошёл. Прежде возвращался нетронутым исходный `result.note` (обрыв
        // свободного хода), и разбор отчёта видел «ход обрезан лимитом длины…» без
        // единого слова о том, что дозаполнение следом закрыло часть полей и на каких
        // остановилось — эту сводку `FormFillExecutor` печатает в лог (`hooks.onText`),
        // но в StageResult, который уходит в `report.md`, она не попадала (разбор серии
        // v11, 2026-09-15: explore на freeship — дозаполнение закрыло 29 полей из ~46,
        // а итоговая причина осталась исходной, будто рескью не пытался вовсе).
        return { ...withEnv, note: `${withEnv.note} — рескью дозаполнением не закрыл бланк: ${fill.summary}` };
      }
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
    if (closableFailure && notDone().length === 0 && (await codeChanged())) {
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
  ): Promise<{ ok: boolean; modelRequests: number; envFailure?: string; summary: string }> {
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
      maxResultBytes: localResultBytes(limits),
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
    // Отказ среды внутри дозаполнения — признаком, а не только текстом: без него стенд не
    // повторял этап, и сбой провайдера на полях записывался провалом модели.
    return {
      ok: fill.ok,
      modelRequests: fill.modelRequests ?? 0,
      // `finalText`, а не `note`: `note` при отказе — это одна строка стража (например
      // «в артефакте остались незаполненные поля»), а `finalText` — полная сводка
      // (сколько заполнено, сколько осталось, что отклонено), та же, что уходит в лог.
      summary: fill.finalText,
      ...(fill.envFailure === undefined ? {} : { envFailure: fill.envFailure }),
    };
  }

  /**
   * Права этапа плюс права на MCP, если оператор выдал этому этапу инструменты.
   *
   * Само определение этапа про MCP не знает и знать не должно: набор инструментов задаётся
   * конфигом ПРОЕКТА, а `stages.ts` общий для всех. Поймано живым прогоном: инструменты
   * модели выдавались, вызов доходил до политики и отклонялся ею — «читающие вызовы MCP не
   * разрешены на этапе», потому что права не выдавал никто.
   */
  private toolsFor(stage: StageId, preparationV2 = isPreparationV2(this.paths)): readonly ToolName[] {
    const all = stageById(stage).tools;
    // Урезанный набор для модели с `leanTools` — только на этапах-документах. Это
    // ГИПОТЕЗА журнала, а не замер: «сокращение числа инструментов» стоит в списке
    // непробованного (`docs/model-runs.md`), ручка и заведена, чтобы его замерить.
    // Сужаются ПРАВА, не только показ:
    // политика видит тот же список, и второго места решения о доступе не появляется.
    // На chunk/verify набор не трогаем: там Write/Bash нужны по делу.
    const route = this.profile.routes[stage];
    const leaned =
      route.leanTools && stageModule(stage).leanDocTools && !preparationV2
        ? all.filter((t) => LEAN_TOOLS.has(t))
        : all;
    // FillField выдаётся ТОЛЬКО при включённой ручке (compactForms 'fill'|'all') — иначе
    // замер этой ручки перестал бы быть замером «одной ручки»: право появлялось бы у всех
    // моделей стадии сразу, без записи в config/models.json, которую и сравнивает журнал.
    const compactFillRoute = route.compactForms === 'fill' || route.compactForms === 'all';
    const base = preparationTools(leaned, stage, preparationV2, compactFillRoute);
    if (preparationV2) return base;
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
  private usesFormFill(stage: StageId, route: ResolvedRoute, preparationForms = true): boolean {
    if (readGuided(this.paths) && route.flow === 'loop' && ['verify', 'handoff'].includes(stage)) return true;
    if (preparationForms && isPreparationV2(this.paths)) {
      // Preparation v2 owns document construction: every supported document stage uses
      // bounded field answers rather than asking the model to edit a growing Markdown file.
      // Plan waits for verified exploration evidence; intent does not need that prerequisite.
      return route.flow === 'loop' && (stage === 'intent' || stage === 'plan') &&
        stageModule(stage).formFillExecutor &&
        (stage !== 'plan' || preparationExploreEvidenceProblem(this.paths) === null);
    }
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

  /**
   * Маршрут независимого скана ревью этапа 6 и право его находок ронять вердикт
   * (`reviewRoute.ts::decideReviewScan`): отдельный `reviewModel` из конфига раннера либо
   * маршрут этапа verify; скан той же моделью, что исполнитель (chunk), — справочный
   * (advisory). Резолвится ВНЕ профиля, поэтому инвариант «одна локальная модель в
   * guided» (проверка маршрутов профиля выше) его не видит — это и есть единственное
   * допустимое исключение из него.
   *
   * В guided конвейерные ручки ревью принудительно включаются и на заданном
   * `reviewModel` — тем же правилом, что для маршрутов verify профиля (ниже в
   * `runStage`): свободный ход субагента на локальной модели не проходит по бюджету.
   */
  private reviewScanRoute(): ReviewScanDecision {
    const decision = decideReviewScan({
      reviewModelId: this.config.runner.reviewModel,
      models: this.config.models,
      executor: this.profile.routes.chunk,
      verifyRoute: this.profile.routes.verify,
    });
    if (readGuided(this.paths) === null) return decision;
    const route = decision.route;
    if (route === this.profile.routes.verify || route.flow !== 'loop') return decision;
    return {
      ...decision,
      route: { ...route, reviewFill: true, claimFill: true, skipTurnAfterReviewFill: true },
    };
  }

  private executorFor(stage: StageId, forRoute?: ResolvedRoute, preparationForms = true): StageExecutor {
    const route = forRoute ?? this.profile.routes[stage];
    if (stage === 'chunk' && readGuided(this.paths) !== null) return guidedExecutor(this.host, route);
    if (preparationForms && stage === 'ask' && readGuided(this.paths) !== null) return new GuidedAskExecutor(this.host, {
      provider: createProvider(route.provider, route.providerDef, this.config.runner.limits.chatTimeoutMs, this.trace(stage, 'loop')),
      params: route.params, contextWindow: route.contextWindow ?? 16384 });
    if (preparationForms && stage === 'plan' && readGuided(this.paths) !== null) return new GuidedPlanExecutor({
      paths: this.paths, slug: this.slug, provider: createProvider(route.provider, route.providerDef, this.config.runner.limits.chatTimeoutMs, this.trace(stage, 'formFill')),
      params: route.params, contextWindow: route.contextWindow ?? 16384 });
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
    // `runStage` (`runClaimsBlind`, хук модуля explore) и лежит в `exploreState.claims`.
    if (stage === 'explore' && (usesExploreFill(route) || (preparationForms && isPreparationV2(this.paths)))) return exploreFillExecutor(this.host, route);

    // Режим заполнения по полям — только там, где этап и есть заполнение бланка.
    // Explore сюда не входит: его отчёт пишется по результатам разведки субагентами,
    // а не выводится из входов; chunk/verify — тем более.
    if (this.usesFormFill(stage, route, preparationForms)) {
      return new FormFillExecutor({
        provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, this.trace(stage, 'formFill')),
        maxResultBytes: localResultBytes(limits),
        readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
        bashTimeoutMs: limits.gateTimeoutMs,
        params: route.params,
        // Расчёт `max_tokens` по остатку окна (`FormFillExecutor.paramsFor`) — тот же приём,
        // что у `StepExecutor`/`ExploreExecutor`; до этой правки маршруты `compactForms`
        // с объявленным `contextWindow` не получали от него никакой защиты здесь
        // (code-review-all, 2026-09-14).
        ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
        currency: route.providerDef.currency ?? 'USD',
        // Preparation v2 uses schema-guided answers for all model routes. Outside v2,
        // keep the per-model compactForms setting.
        compact: isPreparationV2(this.paths) || route.compactForms === 'fill' || route.compactForms === 'all',
        preparationV2: isPreparationV2(this.paths),
        reviewIntentClaims: stage === 'intent' && readGuided(this.paths) !== null,
        reviewIntentContract: stage === 'intent' && readGuided(this.paths) !== null,
        intentRequests: preparation(this.paths)?.requests ?? [],
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
    if (stage === 'chunk' && route.stepFill && !isPreparationV2(this.paths)) return stepFillExecutor(this.host, route);

    return new LoopExecutor({
      provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, this.trace(stage, 'loop')),
      // Свой потолок у локального контура: общий рассчитан на большое окно, а здесь один
      // `Read` по нему забирал почти весь контекст 16K — измерено на прогоне.
      maxResultBytes: localResultBytes(limits),
      readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
      bashTimeoutMs: limits.gateTimeoutMs,
      // Температуру не задаём: у части серверов «не задано» и «0» ведут себя по-разному,
      // и подставлять своё значение молча — значит менять поведение модели за оператора.
      // Оператор задаёт её (и любой другой параметр) сам — в `params` записи модели.
      temperature: null,
      params: route.params,
      currency: route.providerDef.currency ?? 'USD',
      // Явная ручка записи (`ModelDef.historyBudgetBytes`) побеждает; без неё — по окну
      // маршрута, если оно заявлено (`historyBudgetFor`), иначе прежний плоский потолок.
      historyBudgetBytes:
        route.historyBudgetBytes ??
        (route.contextWindow === undefined
          ? limits.localHistoryBudgetBytes
          : historyBudgetFor(route.contextWindow, limits.localHistoryBudgetBytes)),
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
  preparePrompt(stage: StageId, opts: { requirement?: string; extra?: string; preparationVersion?: 1 | 2 | 3 } = {}): PreparedPrompt {
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
    const preparationV2 = isPreparationV2(this.paths) || (stage === 'intent' && opts.preparationVersion !== 1 && !readArtifact(this.paths.intent).exists && !readArtifact(this.paths.plan).exists && !readArtifact(this.paths.explorationReport).exists);
    const structuredPreparation = preparationV2 && route.flow === 'loop' &&
      (stage === 'intent' || stage === 'explore' || stage === 'plan');
    const prompt = buildPrompt({
      runner: this.config.runner,
      stage: def,
      ctx: this.ctx,
      flow: route.flow,
      slug: this.slug,
      preparationV2,
      // Preparation v2 usually keeps its authored forms verbatim. If this route
      // uses the runtime-owned structured form, keep the matching field-answer prompt
      // enabled for every model route.
      compactForms:
        structuredPreparation
          ? 'fill'
          : preparationV2
            ? 'off'
            : route.compactForms,
      // Тем же условием, каким выбирается исполнитель: промпт обязан знать, что
      // инструментов в запросах этого этапа не будет.
      formFill: structuredPreparation || (!preparationV2 && stage === 'explore' && usesExploreFill(route)),
      // Эффективный набор, а не `stage.tools`: урезание `leanTools` обязано быть видно
      // в промпте — панель показывает ровно тот список, с которым уйдёт запрос.
      // MCP-права здесь не нужны: у внешних инструментов своя строка в adapter-блоке.
      tools: (structuredPreparation ? [] : this.toolsFor(stage, preparationV2)).filter((t) => t !== 'McpRead' && t !== 'McpWrite'),
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
    if (readGuided(this.paths) && (stage === 'explore' || stage === 'plan' || stage === 'chunk')) {
      prompt.presetNote = 'guided: исполнитель формирует отдельные JSON-запросы по текущему состоянию. Фактические запросы и ответы доступны в трассе этапа.';
    }
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
    // Тело — `stages/entry.ts::entryProblems`: дашборд считает те же блокеры по диску без `Run`.
    return entryProblems(stage, this.ctx, this.gatesFile, {
      ...(opts.abortHandoff === undefined ? {} : { abortHandoff: opts.abortHandoff }),
      withBlame,
      ...(precomputed === undefined ? {} : { precomputed }),
    });
  }

  /**
   * Последний ИЗВЕСТНЫЙ (не обязательно свежий) провал пробы среды этапа — для GET-ручек,
   * чтобы оператор видел его ДО клика «Старт». Не блокер: при запуске этапа проба
   * повторяется (`resetOnEnter` verify), а среди `blockers()` он выключал кнопку запуска
   * и после починки среды — навсегда до рестарта (code-review-all 2026-09-23). Синхронный
   * кэш, а не сама проба: она ходит в Docker, а список витков опрашивается постоянно.
   */
  envNotes(stage: StageId): string[] {
    return stage === 'verify' ? [...this.state.verify.lastPreflightBlockers] : [];
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
    const skipped: string[] = [];
    for (const b of blocks) {
      // Бланк, напечатанный текстом, почти всегда идёт без полей решения человека — модель
      // их не заполняла и в свой пересказ не перенесла. Это запись РАНТАЙМА, не модели, и
      // стёртое поле возвращается здесь безусловно, а не по ручке `restoreErasedDecisions`:
      // живой прогон (ollama:gpt-oss-20b-agent, rename-field, 2026-09-24) — журнал на 5 834
      // токена ушёл в `Write` без «Подтвердил», гейт отклонил «стирание поля», и ход вместе
      // с попыткой сгорели, хотя содержимое было годным. Поле, которое вернуть нельзя
      // (массовая потеря, сломанная структура), — блок пропускается: писать документ без
      // решения человека нельзя, а гейт лишь повторил бы тот же отказ.
      const draft: NormalizedCall = { kind: 'write', path: b.path, content: b.content };
      const erased = repairErasedDecisions(draft, this.project.projectRoot);
      const lost = erased.loss?.decisionsLost ?? [];
      if (erased.repair === null && lost.length > 0) {
        skipped.push(`${b.path} — стёрто поле решения человека (${lost.map((l) => `«${l}»`).join(', ')}), вернуть его в текст не удалось`);
        continue;
      }
      const draftContent = erased.repair === null ? b.content : erased.repair.content;
      const call: NormalizedCall = { kind: 'write', path: b.path, content: draftContent };
      const decision = await this.gate.request({
        runId: this.id,
        stage,
        requestId: `salvage-${this.salvageSeq++}`,
        toolName: 'Write',
        rawInput: { file_path: b.path, content: draftContent },
        call,
        ctx: this.policyContext(stage),
      });
      if (!decision.allowed) continue;
      // Правка оператора применяется, как на любом другом пути записи: он открыл карточку,
      // исправил содержимое и одобрил ИСПРАВЛЕННОЕ. Игнорировать `updatedInput` здесь
      // значило бы записать на диск не то, что он подтвердил, — при том что сообщение в
      // журнал утверждает «записано через гейт одобрения».
      const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
      const content = typeof edited === 'string' ? edited : draftContent;
      writeArtifact(b.path, content);
      written.push(b.path);
    }

    const skippedNote = skipped.length === 0 ? '' : `; не спасено: ${skipped.join('; ')}`;
    if (written.length === 0) {
      return skipped.length === 0 ? null : `содержимое артефакта было напечатано в ответ, а не записано инструментом${skippedNote}`;
    }
    return (
      `содержимое артефакта было напечатано в ответ, а не записано инструментом — ` +
      `рантайм записал его через гейт одобрения: ${written.join(', ')}${skippedNote}`
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
    const { verdict: rawVerdict, input } = computed;
    const withNotes = applyEnvRetryBudget(this.paths, this.chunk, this.verdictCycle, rawVerdict, envRetryBudget(this.gatesFile));
    this.state.verify.verdict = withNotes;
    // Журнал отражает каждый завершённый Verify, включая повтор на той же попытке.
    // Чистый пересчёт внутри одного прогона строку не удваивает.
    if (this.recordedVerdictCycle !== this.verdictCycle) {
      this.recordIteration(withNotes, noProgress);
      this.recordedVerdictCycle = this.verdictCycle;
    }

    // Статистика попытки учитывается РОВНО ОДИН РАЗ. Пересчёт вердикта на той же попытке
    // (оператор поправил набор гейтов и запустил verify снова) обязан обновить сам
    // вердикт, но не удваивать историю: иначе одна неудача выглядит как две.
    const key = `${this.chunk}:${this.attempt}`;
    if (this.state.verify.verdictCountedFor !== key) {
      this.state.verify.verdictCountedFor = key;
      // Гейт-агрегаты — по тем же статусам, что ушли в вердикт: рантайм видел прогон
      // рецензента своими глазами, и `⏭`, стоявшее там до его вызова, метрикой не является.
      for (const g of gateResultsForVerdict(this.host)) this.recordGateResult(g);
      this.verdictCount += 1;
      if (!withNotes.passed) this.redCount += 1;
      if (this.state.verify.redCause !== null) {
        this.redByCause.set(this.state.verify.redCause.kind, (this.redByCause.get(this.state.verify.redCause.kind) ?? 0) + 1);
      }
      // `manual` сюда не идёт: пункт, освобождённый человеком от автоматической проверки,
      // «не закрывается вторую попытку подряд» по построению, и предложение поднять модель
      // из-за него — совет лечить то, что не болеет.
      // `blocked_env` ничего не проверял (`SDLC.md`): его ⚠ по пунктам, держащимся на тестах,
      // в счёт «второй красный подряд» для эскалации не идут (ревью).
      if (rawVerdict.action !== 'blocked_env') {
        this.failedClaimsByAttempt.push(
          input.claims.filter((c) => c.status !== '✅' && c.status !== 'manual').map((c) => c.id),
        );
      }
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
    this.cancelRequested = true;
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
    if (opts.executionMode !== undefined && opts.executionMode !== 'legacy' && opts.executionMode !== 'guided') throw new Error('Неизвестный режим исполнения');
    if (opts.executionMode === 'legacy' && readGuided(this.paths)) throw new Error('Режим задачи уже закреплён как guided');
    if (opts.executionMode === 'guided' && !readGuided(this.paths)) {
      if (!stageModule(stage).def.startsTask || readArtifact(this.paths.intent).exists) throw new Error('guided выбирается при создании новой задачи');
      if (opts.preparationVersion !== undefined && opts.preparationVersion !== 3) throw new Error('guided требует preparationVersion=3');
      const selected = this.profile.routes.intent;
      const routes = Object.values(this.profile.ensemble).flat();
      if (routes.some(r => r.flow !== 'loop' || r.model !== selected.model || r.provider !== selected.provider ||
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(r.providerDef.baseUrl ?? 'http://invalid').hostname))) {
        throw new Error('guided требует одну локальную модель на всех этапах и маршрутах ревью');
      }
      initGuided(this.paths, `${selected.provider}:${selected.model}`);
    }
    const guided = readGuided(this.paths);
    if (guided) {
      opts = { ...opts, preparationVersion: 3 };
      if ([...Object.values(this.profile.routes), ...Object.values(this.profile.ensemble).flat()].some(r =>
        `${r.provider}:${r.model}` !== guided.modelId || r.flow !== 'loop' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(r.providerDef.baseUrl ?? 'http://invalid').hostname))) throw new Error('Локальная модель guided-задачи изменена');
      if (guided.activeMs >= guided.budgetMs) return { ok: false, finalText: '', usage: emptyUsage(), note: 'Лимит guided-задачи 30 минут исчерпан' };
      for (const r of [this.profile.routes.verify, ...this.profile.ensemble.verify]) {
        r.reviewFill = true;
        r.claimFill = true;
        r.skipTurnAfterReviewFill = true;
        r.formFill = true;
      }
    }
    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const abortOpts = opts.abortHandoff === true ? { abortHandoff: true } : {};
    this.currentAbortHandoff = opts.abortHandoff === true;
    this.cancelRequested = false;
    const mod = stageModule(stage);
    mod.initialize?.(this.host, opts);
    const inv = mod.begin?.(this.host, route, abortOpts) ?? {};

    // Сброс состояния этапа на входе — ДО блокеров: устаревший кэш прошлого прохода
    // (pre-flight verify, индекс explore) иначе заблокировал бы или подменил этот проход.
    inv.resetOnEnter?.();

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
      // Условный этап закрывается артефактом всегда (`SDLC.md`: «нет артефакта — нет
      // шага»): этап 3 без вопросов оставляет отчёт «по существу пусто», а не пустоту.
      await inv.onSkip?.(report.skip);
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: true, note: report.skip });
      return { ok: true, finalText: '', usage: emptyUsage(), note: report.skip };
    }

    // Маркеры терминальной реализации (`hooks/sdlc-guard.py`: `.scope.json`, `.review-lock`,
    // `.claims-lock`) в каталоге витка — состояние ЧУЖОЙ сессии: границу scope и замок
    // ревью здесь держит рантайм, а оставленный маркер запер бы следующий терминальный шаг.
    this.clearGuardMarkers(stage);

    // Блокер среды этапа (pre-flight песочницы verify) — после проверки пропуска, до старта
    // попытки: несоответствие среды не должно съедать попытку.
    const entryBlocker = (await inv.entryBlocker?.()) ?? null;
    if (entryBlocker !== null) {
      this.status = 'failed';
      this.emit({ type: 'error', runId: this.id, stage, message: entryBlocker });
      return { ok: false, finalText: '', usage: emptyUsage(), note: entryBlocker };
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
    if (mod.checksBranchOnEntry) {
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
          `не найдены определения субагентов: ${missing.join(', ')} (каталог ${this.config.runner.agentsDir === '' ? 'не задан — нет methodologyDir/agentsDir' : this.config.runner.agentsDir}). ` +
          (mod.missingSubagentsNote ??
            'Этап пойдёт без независимого агента: ограничение прав держится на промпте, ' +
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
    if (this.cancelRequested) this.aborter.abort();

    // Метрики этапа копятся на витке: сколько раз он запускался, сколько это стоило и
    // сколько занял. Время меряется здесь, а не по событиям шины: буфер шины вытесняет
    // старое, и считать по нему длительность значило бы терять её на длинных витках.
    const stageStartedAt = Date.now();
    let guidedTick = Date.now();
    const chargeGuided = (): void => {
      const now = Date.now();
      if (guided && accountGuidedTime(this.paths, now - guidedTick, this.status === 'running')) this.aborter?.abort(new Error('Лимит guided-задачи 30 минут исчерпан'));
      guidedTick = now;
    };
    const guidedTimer = guided ? setInterval(() => {
      try { chargeGuided(); }
      catch (error) { this.aborter?.abort(error); }
    }, 1000) : null;
    const stat = this.stageStats.get(stage) ?? { runs: 0, usage: emptyUsage(), durationMs: 0, requestDurationsMs: [] };
    stat.runs += 1;
    this.stageStats.set(stage, stat);

    // `try` начинается ЗДЕСЬ, сразу после `stage_started` и `running`: всё ниже —
    // `afterStart` (baseline chunk, коммит handoff), `enterFacts` (гейты verify),
    // раскладка и автозаполнение форм, сборка промпта — бросает на сбое диска или git,
    // и вне `try` этап оставался `running` навсегда: без `stage_done`, без снапшота
    // метрик, с неснятыми ожиданиями одобрения (code-review-all 2026-09-23).
    try {
      await inv.afterStart?.();

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

      // Факты рантайма этапа: итоги гейтов verify, диагноз ретрая chunk, ветка intent,
      // пост-виток отчёт handoff — модель переносит их, но не сочиняет.
      for (const block of (await inv.enterFacts?.(this.aborter.signal)) ?? []) {
        appended = appended === undefined ? block : `${appended}\n\n${block}`;
        extra = extra === undefined ? block : `${extra}\n\n${block}`;
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
      // Подготовка этапа до раскладки форм (снимок рабочего дерева chunk).
      await inv.beforeSeed?.();

      // Строка трения заводится ДО исполнителя. Пока она создавалась первым же счётчиком,
      // этап, не сделавший ни одного вызова и не получивший ни одного напоминания, в метрики
      // не попадал вовсе — то есть самый тяжёлый исход выглядел как отсутствие трения, а
      // приписка в постмортеме обещала читателю строку «Вызовов: 0», которой не бывало.
      if (!this.friction.has(stage)) this.friction.set(stage, EMPTY_FRICTION());

      const produced = def.produces(this.ctx);
      const missingBefore = missingNow(produced);
      const seeded = seedArtifacts(produced, this.config.runner.methodologyDir);
      seedPreparationForms(this.paths, seeded);
      this.seeded = seeded.map((s) => s.path);

      // Версия формы (`<!-- sdlc-template: X vN -->`): артефакт, снятый другой версией
      // формы, этап не заполняет — его механика написана под текущую. Без строки версии
      // (старый виток) — только предупреждение: старые витки дочитываются.
      const versionProblem = this.templateVersionBlocker(stage, produced.filter((p) => !this.seeded.includes(p)));
      if (versionProblem !== null) {
        this.status = 'failed';
        this.emit({ type: 'error', runId: this.id, stage, message: versionProblem });
        return { ok: false, finalText: '', usage: emptyUsage(), note: versionProblem };
      }

      // Механика артефактов до модели: хук этапа (журнал chunk'а, «Ветка витка» intent, отчёт
      // приёмки verify), затем задания `mechanicalJobs` (план, готовность, названия отчётов 2–3).
      // Снимок после подстановки уходит в `SeededArtifact.snapshot` — страж «бланк байт-в-байт»
      // сравнивает с ним, и этап, не сделавший ничего, по-прежнему виден.
      await inv.autofill?.(seeded);
      await this.autofillMechanicalFields(stage, seeded);

      // Что считается «этап ничего не произвёл»: файла нет ИЛИ он остался бланком байт в
      // байт. Без второй половины проверка стала бы самообманом — бланк кладёт сам рантайм.
      const notDone = (): string[] => [
        ...stillMissing(produced, missingBefore),
        ...untouchedSeeds(seeded).filter((path) => !isRuntimeOwnedSeed(stage, path)),
        ...(inv.extraNotDone?.() ?? []),
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
      const pendingReads = new Map<string, { path: string; stage: StageId }>();
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

      let skippedApprovedLocationAsk = false;
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
            question: clip(question, EXCHANGE_QUESTION_CHARS),
            answer: clip(answer, EXCHANGE_ANSWER_CHARS),
          }),

        onToolRequest: async (call, meta) => {
          chargeGuided();
          if (guided) this.aborter?.signal.throwIfAborted();
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
                // Слепота второго агента разведки — конструкцией, не просьбой (`sdlc-explore`
                // Phase 1, `.claims-lock` терминального hook'а): субагенту `sdlc-claims`
                // закрыты на чтение задача и отчёт разведки — авторский лист он не видит по
                // построению шага. Только флоу `loop`: харнесс `sdk` вызывающего не называет.
                ...(meta.caller === 'sdlc-claims'
                  ? {
                      readDenied: [
                        ...(ctx.readDenied ?? []),
                        this.paths.intent,
                        this.paths.explorationReport,
                        // Готовность обсуждает лист, лента несёт промпты этапов 1–2 с задачей
                        // целиком, план и передачи прошлых витков цитируют пункты (ревью).
                        this.paths.readiness,
                        this.paths.plan,
                        this.paths.handoff,
                        this.paths.events,
                        this.paths.intentSections,
                      ].map((p) => relOf(this.ctx, p)),
                    }
                  : {}),
                // Флоу — по ВЫЗОВУ, а не по основному маршруту этапа: маршрут ансамбля verify
                // может идти другим флоу (code-review-all 2026-09-23).
                noArtifactReaddress: meta.sdk !== undefined,
                ...(meta.sdk?.sessionDir == null ? {} : { harnessResultsRoot: meta.sdk.sessionDir }),
              },
            });
            if (decision.allowed && call.kind === 'read' && mod.tracksPreparationReads === true) {
              pendingReads.set(meta.requestId, { path: call.path, stage });
            }
            // Рецензентом считается ровно тот субагент, чьё определение этап объявил и
            // рантайм прочитал с диска. Подстрока «reviewer» в имени этой планкой не
            // является: модель, вызвавшая несуществующего `code-reviewer-helper`, получала
            // отказ загрузки — и всё равно зажигала гейт минимальной пятёрки.
            if (decision.allowed && call.kind === 'subagent' && call.agent === 'sdlc-claims' && meta.sdk !== undefined) {
              this.emit({
                type: 'warning',
                runId: this.id,
                stage,
                message:
                  'субагент sdlc-claims во флоу sdk: слепота к авторскому листу конструкцией не гарантирована — хук харнесса не отличает чтения субагента от чтений этапа; независимый лист выводит и рантайм (deriveClaimsBlind)',
              });
            }
            if (decision.allowed && call.kind === 'subagent' && reviewerNames.has(call.agent)) {
              pendingReviewer.add(meta.requestId);
            }
            // Прогресс — правка вне артефактов витка: правка журнала chunk'а в `.sdlc`
            // гасила напоминание о нулевом прогрессе ровно в том случае, под который оно
            // заведено (журнал заполнен, код не тронут — серия v4, `ministral`/`security-bait`).
            // Путь — сырая строка модели: сравнивается тем же лексическим приведением, что у
            // политики (регистр диска, `..`, обратные слэши), иначе `src/../.sdlc/x` засчитывался.
            // Путь — фактически исполняемый: гейт мог перенаправить запись своего артефакта
            // (`approval/artifactAddress.ts`) из корня в `.sdlc`, и журнал chunk'а, записанный
            // «не по адресу», иначе засчитывался правкой кода (code-review-all 2026-09-23).
            const written =
              decision.allowed && decision.updatedInput !== null && (call.kind === 'write' || call.kind === 'edit')
                ? normalize(meta.toolName, decision.updatedInput as Record<string, unknown>)
                : call;
            if (
              decision.allowed &&
              (written.kind === 'write' || written.kind === 'edit') &&
              !inSdlcDir(this.ctx.paths.projectRoot, written.path)
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
            guidedTick = Date.now();
            this.status = 'running';
          }
        },

        onToolResult: (meta) => {
          this.countFriction(stage, 'toolCalls');
          const pendingRead = pendingReads.get(meta.requestId);
          if (pendingRead !== undefined && meta.ok && meta.resultText !== undefined) {
            recordPreparationRead(this.paths, pendingRead.stage, pendingRead.path, meta.resultText);
          }
          pendingReads.delete(meta.requestId);
          // Гейт «Ревью независимым агентом» зеленеет только по состоявшемуся ревью: вызов
          // дошёл до результата без ошибки И ответ прошёл планки этапа (`reviewAccepted` —
          // у verify те же, что у прямого прогона). Прежде здесь хватало `ok` — пустой ответ
          // субагента зеленил гейт (code-review-all 2026-09-23). Этап без хука — прежнее
          // правило «состоялся вызов».
          if (meta.ok && pendingReviewer.has(meta.requestId)) {
            if (inv.reviewAccepted?.(meta.resultText ?? '') ?? true) this.markReviewerRan();
          }
          pendingReviewer.delete(meta.requestId);
          if (pendingWrites.has(meta.requestId)) {
            if (meta.ok) {
              acceptedWrites += 1;
              this.gate.noteTreeChanged(this.id);
            }
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

        onSubagentResult: (agent, response) => mod.subagentResult?.(this.host, agent, response, seeded) ?? null,

        onAskHuman: async (call) => {
          if (call.kind !== 'ask_human') return {};
          if (inv.locationAlreadyApproved?.(call.questions)) {
            skippedApprovedLocationAsk = true;
            return {};
          }
          chargeGuided();
          if (guided) this.aborter?.signal.throwIfAborted();
          this.status = 'awaiting';
          try {
            return await this.askGate.ask({ runId: this.id, stage, questions: call.questions });
          } finally {
            guidedTick = Date.now();
            this.status = 'running';
          }
        },

        afterAskHuman: (call, answers) => {
          if (call.kind !== 'ask_human') return null;
          if (skippedApprovedLocationAsk) {
            skippedApprovedLocationAsk = false;
            return 'Точки правки уже входят в одобренный актуальный план и проверены рантаймом. Повторное подтверждение места не требуется; реализуй план через инструменты редактирования файлов. Вопросы о поведении и требованиях по-прежнему задавай человеку.';
          }
          return isPreparationV2(this.paths) ? recordModelAnswers(this.host, call.questions, answers) : (inv.afterAskHuman?.(call.questions, answers) ?? null);
        },

        // Записи в отчёт этапа 6. Здесь только приём и проверка ссылки: в файл они попадут
        // одним `Write` после хода, обычным путём через политику и гейт.
        // Записи той же модели, что исполнитель (маршрут этапа совпадает с chunk), —
        // справочные (advisory): саморевью уровнем вердикта не является.
        onRecord: (call) => acceptRecord(this.host, call, {
          advisory: routeKey(route) === routeKey(this.profile.routes.chunk),
        }),

        onUsage: (usage, durationMs) => {
          const st = this.stageStats.get(stage);
          if (st !== undefined) {
            st.usage = addUsage(st.usage, usage);
            // Отдельно от суммы: критерий квалификации рецензента (пункт 2,
            // `docs/proposals/reviewer-qualification.md`) судит по ОДНОМУ запросу, не по
            // сумме — зависший на 20 минут запрос топит получасовой бюджет этапа, а сумма
            // это не покажет.
            // `> 0`, не только `!== undefined` — тот же порог, что `accountOffPathUsage`
            // выше по файлу (её докстринг уже утверждает «тем же приёмом»; до этой правки
            // приёмы расходились — `0` сюда прошёл бы, туда нет — code-review-all,
            // 2026-09-28).
            if (durationMs !== undefined && durationMs > 0) st.requestDurationsMs.push(durationMs);
          }
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
          this.emit({
            type: 'usage',
            runId: this.id,
            stage,
            usage,
            total: this.totalUsage,
            ...(durationMs === undefined ? {} : { durationMs }),
          });
        },

        onWarn: (message) => this.emit({ type: 'warning', runId: this.id, stage, message }),

        onFriction: (kind) => this.countFriction(stage, kind),
      };

      // Исполнитель создаётся ВНУТРИ try: `createProvider` бросает при отсутствии ключа
      // и на нереализованном маршруте, а к этому моменту уже отправлен `stage_started`,
      // выставлен статус `running` и — для этапа 6 — прогнаны все гейты, то есть сборка
      // и тест-сьют. Пока бросок случался снаружи, `finally` не отрабатывал: статус
      // навсегда оставался `running`, `stage_done` не приходил, и кнопка запуска в
      // интерфейсе не разблокировалась до перезагрузки страницы.
      // Шаг рантайма до создания исполнителя (слепой лист разведки).
      await inv.beforeExecutor?.();

      const executor = this.executorFor(stage);

      // Шаг рантайма до хода модели (независимое ревью verify): его блок подклеивается к
      // промпту хода, а готовый исход, если он есть, заменяет сам ход.
      const pre = (await inv.preTurn?.(prompt, agents, hooks)) ?? { block: null, skip: null };
      const stagePrompt = pre.block === null ? prompt : withExtra(prompt, pre.block);

      // Последняя находка собственной проверки этапа, выданная стражем. Нужна пересчёту
      // после доборов ниже: переворачивать исход можно, только если этап упал ИМЕННО на
      // ней, — иначе провал по бюджету, лимиту ходов или анти-циклу при молчащем страже
      // становился бы зелёным (code-review-all 2026-09-23).
      let lastStageProblem: string | null = null;
      // «Ход завершён» и «работа сделана» — разные утверждения, и второе проверяется
      // диском. Замечание даёт модели доделать в том же этапе, а не отчитаться пустым.
      const finishGuard = (): string | null => {
        const missing = notDone();
        if (missing.length > 0) {
          return (
            `артефакт этапа не заполнен: ${missing.join(', ')}. Ход не закончен — ` +
            `открой файл, замени места «‹…›» своим содержимым и сохрани инструментом Edit.`
          );
        }
        // Своя проверка этапа в его же ходу (полнота intent, фактичность карты разведки,
        // разбор последствий плана): находка нужна модели, пока она ещё здесь.
        lastStageProblem = inv.finishProblem?.() ?? null;
        return lastStageProblem;
      };

      await inv.beforeModel?.(hooks, seeded);
      const execRequest: ExecRequest = {
          prompt: stagePrompt,
          cwd: this.project.projectRoot,
          model: route.model,
          allowedTools: this.toolsFor(stage),
          readOnlyDirs: this.readOnlyRoots,
          subagents: agents,
          mcp,
          finishGuard,
          // Спасение напечатанного артефакта: модель составила его правильно, но не
          // записала. Идёт тем же путём, что обычная запись — политика и гейт одобрения.
          salvageFromText: (text) => this.salvageFromText(text, produced, stage),
          maxTurns: this.maxTurnsFor(stage),
          maxBudgetUsd: this.project.maxBudgetUsd,
          spentUsdBefore: this.spent.spent(route.providerDef.currency ?? 'USD'),
          // Сигнал прогресса анти-цикла — у этапа свой (записи отчёта verify, принятые правки
          // дерева chunk): обрыв посреди заполняемого артефакта терял уже сделанную работу.
          ...(inv.progress?.(() => acceptedWrites) ?? {}),
          // Для режима заполнения по полям: где искать плейсхолдеры. Обычные исполнители
          // поле не читают.
          formArtifacts: produced,
          // Проактивное закрытие готового этапа (`docs/proposals/model-flow-improvements.md`
          // §1.3/§2.1) — у этапа, где готовый артефакт не значит готовую работу, выключено.
          closeOnFinalizeReady: mod.closeOnFinalizeReady ?? true,
          // Ключ → путь для FillField — тот же список, что уже отдан политике
          // (`policyContext`); нужен исполнителю, чтобы разрешённый политикой вызов дошёл
          // до диска (LoopExecutor кладёт его в ToolContext, SdkExecutor — в свой MCP-сервер).
          stageArtifacts: this.stageArtifacts(stage),
          signal: this.aborter.signal,
        };
      let result: StageResult = pre.skip !== null ? pre.skip : await executor.run(execRequest, hooks);

      // Доборы рантайма после хода, до дозаполнения по полям и ансамбля (добор пунктов и
      // записи отчёта verify, добор осей plan): оба обязаны видеть уже внесённое.
      await inv.afterTurn?.(stagePrompt, this.aborter.signal);

      // Страж завершения (`finishProblem`) отвечал ВНУТРИ исполнителя — ДО доборов
      // `afterTurn`, и его вердикт про записанное добором ничего не знает: строки уже в
      // артефакте, а этап падает со списком находок, снятым до добора (живой замер
      // test24e, 2026-09-22: `planAxisFill` дописал все 6 осей в plan.md — запись
      // `axis-fill-0` одобрена гейтом, — а этап отчитался «нет строк для осей» протухшим
      // текстом стража). Пересчёт только там, где есть И страж, И добор (сегодня это
      // `plan`), и ход не сломан по среде: добор, закрывший последнюю находку, этап
      // спасает; оставшиеся находки идут в заметку свежим текстом. Какие провалы
      // пересчитываются — см. `recheckGuardAfterTopUp`.
      if (inv.afterTurn !== undefined && !this.aborter.signal.aborted) {
        // Провал на оформлении спасается здесь только у этапа без своего дозаполнения
        // (`formFinish`, сегодня это plan): у остальных его спасает `finishFormArtifact` ниже
        // — со своими проверками честности и правки кода, которые здесь обходить нельзя.
        const formComplete =
          inv.formFinish === undefined
            ? () =>
                produced.every((p) => {
                  const a = readArtifact(p);
                  return a.exists && countPlaceholdersExceptDecisions(a.text) === 0;
                })
            : () => false;
        result = recheckGuardAfterTopUp(result, lastStageProblem, finishGuard, formComplete);
      }

      // Дозаполнение артефакта этапа по полям (`ModelDef.formFill`) — ПОСЛЕ хода: модель с
      // готовым содержанием не должна сгорать на оформлении бланка. Что дозаполнять и на
      // каких условиях, говорит этап (`formFinish`); этап закрывается ТОЛЬКО если исполнитель
      // упал именно на оформлении и после дозаполнения на диске всё на месте.
      const finish = inv.formFinish?.(result) ?? null;
      if (
        finish !== null &&
        // Guided executors own their bounded repair loops; a failed judgment must
        // not fall through to legacy form filling (nor become a success there).
        (guided === null || result.ok) &&
        route.flow === 'loop' &&
        (route.formFill || finish.forced) && (!isPreparationV2(this.paths) || guided !== null) &&
        !this.aborter.signal.aborted
      ) {
        result = await this.finishFormArtifact(
          stage,
          finish.path,
          result,
          // Тот же промпт, что видел основной ход, — на этапе 6 он включает блок с
          // отчётом рецензента. Дозаполнение по полям без него добирало бы поля §2–§5
          // «по памяти», не зная о находках, ради которых этап и существует.
          finish.extraBlock === null ? stagePrompt : withExtra(stagePrompt, finish.extraBlock),
          hooks,
          notDone,
          this.aborter.signal,
          finish.requireCodeChange
            ? async () => acceptedWrites > 0 || finish.forced || (await finish.treeChanged?.()) === true
            : () => true,
          finish.honesty ?? (() => null),
        );
      }

      await inv.afterForm?.(prompt, def, agents, hooks);
      // A substantive review finding is repair feedback, not a terminal format
      // failure. Only a new independent review may approve the repaired revision.
      if (result.ok && pre.skip === null && mod.repairFeedback !== undefined) {
        for (let revision = 0; revision < 2 && !this.aborter.signal.aborted; revision++) {
          const feedback = mod.repairFeedback(this.host);
          if (feedback === null) break;
          this.emit({ type: 'warning', runId: this.id, stage, message: `${feedback} (${revision + 1}/2)` });
          const remainingTurns = execRequest.maxTurns - (result.modelRequests ?? 0);
          if (remainingTurns <= 0) break;
          const repaired = await executor.run({ ...execRequest, maxTurns: remainingTurns }, hooks);
          result = { ...repaired, usage: addUsage(result.usage, repaired.usage), modelRequests: (result.modelRequests ?? 0) + (repaired.modelRequests ?? 0) };
          if (!repaired.ok) break;
          await inv.afterForm?.(prompt, def, agents, hooks);
        }
      }

      // Отмена проверяется ДО записи улик. Иначе отменённый этап затирал патч предыдущего
      // состояния снимком наполовину сделанного дерева (а при прерванном сигнале git
      // отдаёт пустой вывод, то есть улика подменялась ложным «правок нет») и запускал
      // тест-сьют, который уже некому ждать.
      const cancelled = this.aborter?.signal.aborted === true;

      // Улики этапа производит рантайм, а не исполнитель (патч и тесты chunk) — и только у
      // неотменённого этапа.
      if (!cancelled) await inv.evidence?.();

      this.reportArtifacts(stage);

      if (cancelled) {
        this.status = 'cancelled';
        const reason: unknown = this.aborter?.signal.reason;
        const note = this.cancelRequested ? 'этап отменён оператором'
          : `этап прерван рантаймом: ${reason instanceof Error ? reason.message : String(reason ?? 'причина не указана')}`;
        this.emit({ type: 'stage_done', runId: this.id, stage, ok: false, note });
        return { ...result, ok: false, note };
      }

      // Вердикт этапа (verify) — сразу после хода, по только что записанному отчёту.
      await inv.verdict?.();

      // Последнее слово об исходе — за диском, а не за исполнителем. Модель, объявившая
      // ход завершённым и не записавшая ни одного из объявленных этапом артефактов,
      // прошедшим этап не считается: во флоу `loop` она уже получила два напоминания, а
      // во флоу `sdk` цикл крутит харнесс, и другого места для этой проверки нет.
      const missingAfter = notDone();
      const failedSilently = result.ok && missingAfter.length > 0;
      // Провал исхода, который этап видит сам (у chunk — дерево не изменилось или неизвестно).
      const stageProblem = inv.outcomeProblem?.(result) ?? null;
      const outcome = failedSilently
        ? {
            ...result,
            ok: false,
            note: `этап закончился, но артефакт не заполнен: ${missingAfter.join(', ')}`,
          }
        : stageProblem !== null
          ? { ...result, ok: false, note: stageProblem }
          : result;

      chargeGuided();
      if (guided) this.aborter?.signal.throwIfAborted();
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
      if (guidedTimer) { clearInterval(guidedTimer); chargeGuided(); }
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
