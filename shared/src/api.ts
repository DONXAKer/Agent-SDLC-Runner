/**
 * Контракт HTTP-ответов.
 *
 * Живёт в общем пакете, а не у каждой стороны своей копией: до этого сервер и интерфейс
 * держали по своему описанию `RunDetail`, и они успели разойтись — интерфейс продолжал
 * ждать поле `events`, которое сервер перестал отдавать. Типы здесь — единственное
 * описание, и расхождение теперь ловится сборкой, а не глазами.
 */

import type {
  FlowId,
  GateRunResult,
  NormalizedCall,
  PolicyVerdict,
  PreparedPrompt,
  Escalation,
  Question,
  RedCause,
  RedCauseKind,
  RunStatus,
  StageId,
  Usage,
  Verdict,
  VerdictAction,
} from './types.ts';

export interface RouteInfo {
  stage: StageId;
  modelId: string;
  provider: string;
  model: string;
  flow: FlowId;
  rank: number;
}

export interface StageInfo {
  id: StageId;
  title: string;
  tools: readonly string[];
  /** Причины, по которым этап не начинается. Пусто — можно стартовать. */
  blockers: string[];
  /**
   * То же для объявленного обрыва витка. `null` — у этого этапа обрыва нет.
   *
   * Отдельным полем, потому что у handoff'а два законных входа с разными предусловиями:
   * штатная приёмка требует отчёта и вердикта, а обрыв — единственный способ оставить
   * запись о том, почему виток бросили. Пока считался только штатный вход, интерфейс
   * показывал обрыв заблокированным ровно в том случае, ради которого он и существует.
   */
  abortBlockers: string[] | null;
  produces: string[];
  /**
   * Поле решения человека, которое этот этап оставляет после себя. `null` — решения
   * здесь нет. Интерфейс по нему рисует кнопку приёмки: решение существует только
   * записанным в артефакт, поэтому кнопка обязана быть там же, где этап.
   */
  decision: { artifact: string; label: string } | null;
}

export interface RunSummary {
  runId: string;
  slug: string;
  project: string;
  profile: string;
  /** Статус последнего ЭТАПА, а не витка — см. `RunStatus`. Типом, а не строкой: с голым
   *  `string` фронт писал рукописные словари статусов, и сборка молчала об их неполноте. */
  status: RunStatus;
  /**
   * Этап, выполняющийся ПРЯМО СЕЙЧАС. `null` — не «этап не начат», а «сейчас не выполняется
   * ни один»: между этапами поле всегда пусто, включая виток, дошедший до `verify`.
   */
  stage: StageId | null;
  chunk: number;
  attempt: number;
  usage: Usage;
}

export interface PendingApproval {
  runId: string;
  stage: StageId;
  requestId: string;
  /** Имя инструмента, как его назвал исполнитель. */
  toolName: string;
  /**
   * Аргументы инструмента до нормализации — то, что правит оператор.
   *
   * Правится именно этот объект, а не `call`: исполнителю уходит `updatedInput` в форме
   * инструмента (`file_path`, `old_string`, …), и подсунуть ему нормализованную форму
   * (`path`, `oldStr`) значило отдать вызов с потерянными полями.
   */
  rawInput: Record<string, unknown>;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: { path: string; before: string | null; after: string } | null;
  writeTargets: string[] | null;
}

export interface PendingQuestions {
  runId: string;
  stage: StageId;
  requestId: string;
  questions: Question[];
}

/**
 * Числа витка. Каждое подтверждается тем, что рантайм видел сам, — рассказ модели сюда не
 * попадает. Без этих чисел «приемлемый срок итераций» неизмерим.
 */
export interface RunMetrics {
  /** Расход по этапам: сколько раз этап запускался и сколько это стоило. */
  stages: {
    stage: StageId;
    runs: number;
    usage: Usage;
    /** Суммарное время исполнения этапа, мс. */
    durationMs: number;
  }[];
  /** Посчитанные вердикты: сколько всего и сколько из них красных. */
  verdicts: { total: number; red: number };
  /**
   * Разбивка красных по классам причин. Пусто — классифицировать было нечего.
   * Не «нет проблем»: это счётчик того, что классификатор смог назвать.
   */
  redByCause: { kind: RedCauseKind; count: number }[];
  /** Попыток на chunk: ключ — номер chunk'а. */
  attemptsByChunk: { chunk: number; attempts: number }[];
}

/**
 * Одна попытка витка так, как её видел рантайм. Тот же источник, что у `iterations.md`:
 * второго описания истории попыток заводить нельзя, иначе они разойдутся.
 */
export interface IterationSummary {
  chunk: number;
  attempt: number;
  passed: boolean;
  action: VerdictAction;
  reasons: string[];
  /** Близость патча к предыдущей попытке. `null` — сравнивать было не с чем. */
  closeness: number | null;
  at: string;
}

export interface RunDetail extends RunSummary {
  projectRoot: string;
  routes: Record<StageId, RouteInfo>;
  attemptBudget: number;
  maxBudgetUsd: number;
  stages: StageInfo[];
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestions[];
  /** Итоги последнего прогона гейтов. Пусто — этап 6 ещё не запускался. */
  gateResults: GateRunResult[];
  /**
   * Прогон гейтов оборван отменой, набор в `gateResults` неполон.
   *
   * Без этого флага частичный набор читался как полный: две зелёные строки вместо
   * обязательной пятёрки выглядели как «всё пройдено» — ложный зелёный на той самой
   * поверхности, которая от него сторожит.
   */
  gatesAborted: boolean;
  /** Вердикт последней попытки. `null` — не считался. */
  verdict: Verdict | null;
  /**
   * Природа красной причины и предложенный ход. `null` — вердикт зелёный или не считался.
   * Предложение, а не переход: возврат на план ломает предусловия следующих этапов.
   */
  redCause: RedCause | null;
  /**
   * Близость патча этой попытки к предыдущей, доля от 0 до 1. `null` — первая попытка или
   * сравнивать не из чего. Показывается числом: утверждение «diff почти тот же» оператор
   * должен иметь возможность проверить глазами.
   */
  progressCloseness: number | null;
  /**
   * Порог, с которого совпадение патчей считается топтанием, — из конфига раннера.
   *
   * Отдаётся в контракте, потому что число НАСТРАИВАЕТСЯ: пока веб сравнивал с
   * захардкоженными `0.9` в шапке и в панели попыток, оператор, опустивший порог,
   * получал предупреждение в причинах вердикта и молчание в интерфейсе — интерфейс
   * спорил с рантаймом, и синхронизировать их было нечем.
   */
  progressClosenessWarn: number;
  /** Числа витка — вход для ответа на вопрос «что съело итерации». */
  metrics: RunMetrics;
  /** Предложение поднять модель, когда один и тот же пункт не закрывается. */
  escalation: Escalation;
  /** История попыток витка: попытка → вердикт → причины. */
  iterations: IterationSummary[];
  // Историю событий здесь не отдаём: клиент получает её по WebSocket при подключении,
  // а дублирование гоняло по проводу полные тексты файлов впустую.
}

/** Патч попытки с разметкой «в плане / вне плана» — вход сводного просмотра. */
export interface RunDiff {
  chunk: number;
  attempt: number;
  patch: string;
  files: { path: string; inPlan: boolean }[];
}

export interface ProjectInfo {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  /**
   * Модели профиля по этапам. Список — ансамбль: несколько независимых прогонов этапа.
   * Строка в конфиге разворачивается в список из одного, поэтому здесь всегда список.
   */
  profiles: { name: string; label: string; stages: Record<StageId, string[]> }[];
}

export interface ConfigInfo {
  operator: string;
  projects: ProjectInfo[];
  models: { id: string; provider: string; model: string; rank: number }[];
  stages: { id: StageId; title: string; tools: readonly string[] }[];
  /** Обзор каталогов доступен, только если на сервере задан `SDLC_BROWSE_ROOT`. */
  browseEnabled: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  root: string;
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface PromptResponse {
  prompt: PreparedPrompt;
  blockers: string[];
}
