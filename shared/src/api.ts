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
  McpServerInfo,
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
  /**
   * Записано ли решение из `decision` прямо сейчас — тем же разбором артефакта, которым
   * его читает предусловие следующего этапа (`readDecision`).
   *
   * `decision` описывает СЛОТ, а не текущее его состояние: он не становится `null` после
   * записи. Без этого поля клиент не мог отличить «ждём приёмки» от «уже приняли», и
   * очередь решений навсегда числила пройденные этапы ждущими.
   */
  decisionRecorded: boolean;
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

/**
 * Статус витка ЦЕЛИКОМ, выведенный из артефактов на диске, — не то же самое, что
 * `RunStatus` (статус последнего этапа живого прогона в памяти).
 *
 * `done`/`aborted` читаются из поля «Приёмка» в `handoff.md` (methodology фиксирует обрыв
 * тем же полем — declined — а не отдельным флагом в файле). `open` — handoff'а ещё нет,
 * но виток сейчас держит сервер в памяти. `unfinished` — ни того, ни другого: виток мог
 * оборваться без записи (закрыли вкладку, забыли) либо просто ещё не начинали handoff в
 * этой сессии сервера — история этого не различает и не должна утверждать больше, чем
 * видно по файлам.
 */
export type HistoryStatus = 'done' | 'aborted' | 'open' | 'unfinished';

export interface HistoryEntry {
  slug: string;
  status: HistoryStatus;
  /** Самый дальний этап, для которого на диске есть артефакт. `null` — только intent не начат. */
  lastStage: StageId | null;
  /** ISO-момент последнего изменения среди файлов витка. */
  updatedAt: string;
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
  /**
   * Предупреждение о перезаписи файла целиком с потерей содержимого. `null` — потери нет.
   *
   * Считает рантайм, а не клиент: решение оператора обязано опираться на то же число, что
   * записано в событии, — иначе панель и журнал говорили бы разное об одном вызове.
   */
  destructive: string | null;
  /**
   * Когда запрос встал в очередь (epoch ms). Интерфейс показывает по нему возраст
   * ожидания: виток многочасовой, и «ждёт 40 минут» — сигнал оператору, которого
   * «ждёт» без числа не даёт.
   */
  createdAt: number;
}

export interface PendingQuestions {
  runId: string;
  stage: StageId;
  requestId: string;
  questions: Question[];
  /** Когда вопрос задан (epoch ms) — по той же причине, что у одобрений. */
  createdAt: number;
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
  /**
   * Трение цикла по этапам: на чём модель буксовала — и фон, на котором оно читается.
   *
   * Отдельно от расхода и вердиктов, потому что отвечает на другой вопрос. Расход говорит
   * «сколько сгорело», трение — «на чём»: на повторах одного вызова, на сломанном JSON в
   * аргументах, на отказах политики или на обрезанных результатах.
   *
   * `toolCalls` и `reminders` добавлены после замеров на локальных моделях: строка «ноль
   * вызовов инструментов, два напоминания» — точный портрет этапа, который «отработал» и
   * не сделал ничего, а прежний набор счётчиков такой этап показывал пустым.
   */
  friction: {
    stage: StageId;
    repeat: number;
    badJson: number;
    denied: number;
    truncated: number;
    toolCalls: number;
    reminders: number;
  }[];
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
  /**
   * Часы сервера в момент ответа (epoch ms). Возраст ожидания решений считается от
   * `createdAt`, проставленного сервером, — вычитать из него клиентское `Date.now()`
   * значит показывать рассинхрон часов как «ждёт 20 мин» на свежем запросе. Клиент
   * выводит поправку `Date.now() - serverNow` и применяет её к каждому возрасту.
   */
  serverNow: number;
  routes: Record<StageId, RouteInfo>;
  attemptBudget: number;
  maxBudgetUsd: number;
  stages: StageInfo[];
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestions[];
  /** Итоги последнего прогона гейтов. Пусто — этап 6 ещё не запускался. */
  gateResults: GateRunResult[];
  /** Внешние MCP-серверы витка и их состояние. Пусто — MCP у проекта не настроен. */
  mcpServers: McpServerInfo[];
  /**
   * Набор MCP-инструментов последнего запущенного этапа и его грубая цена в токенах.
   *
   * Цена показывается числом не ради красоты: набор ограничен потолком, и оператор должен
   * видеть, сколько контекста уходит на описания, ДО того как этап упрётся в окно модели.
   */
  mcpStage: { tools: string[]; estimatedTokens: number };
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
  files: { path: string; inPlan: boolean; adds: number; dels: number }[];
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
