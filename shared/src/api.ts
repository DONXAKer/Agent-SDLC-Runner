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
  GateStatus,
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
  /**
   * Последний известный провал пробы среды этапа (pre-flight песочницы verify) —
   * ПРЕДУПРЕЖДЕНИЕ, а не блокер: при запуске проба повторяется. Пока он жил среди
   * `blockers`, кнопка запуска оставалась выключенной и после починки среды — выйти из
   * этого можно было только рестартом (code-review-all 2026-09-23). Нет у старых сборок.
   */
  envNotes?: string[];
  produces: string[];
  outputContracts: { path: string; purpose: string; origin: StageId; required: boolean; freshness: 'current-run' | 'approved' | 'attempt' | 'live' }[];
  runtimeFacts: { id: string; purpose: string; freshness: 'current-run' | 'approved' | 'attempt' | 'live' }[];
  /**
   * Все артефакты из `produces` существуют на диске И БЕЗ плейсхолдеров — факт, а не
   * вывод. Раньше клиент выводил «пройденность» эвристикой «самый дальний этап без
   * блокеров», и она врала: у «Вопросов» и «Плана» блокеры пусты сразу после intent
   * (им нужен только intent.md, не отчёт разведки) — во время разведки оба красились
   * пройденным/текущим. Одного существования тоже мало: формы раскладывает сам рантайм,
   * и этап, упавший на первом ходу, светился пройденным над нетронутым бланком.
   * Состояние считается тем же чтением диска, что и блокеры.
   */
  produced: boolean;
  /**
   * Этап законно пропускается сейчас (`skipIf` методологии: мелкий контур, вопросов
   * нет). Его артефакта не будет никогда — без этого признака интерфейс вечно предлагал
   * бы «Вопросы» как следующий шаг витка, стоящего на chunk.
   */
  skipped: boolean;
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
  /**
   * Валюта, в которой считает профиль витка: единая валюта всех маршрутов
   * (`ProviderDef.currency`, умолчание USD); у смешанного профиля — `USD` как было,
   * потому что одна сумма в двух валютах честной не бывает. Клиент подписывает ею
   * стоимость вместо безусловного `$`.
   */
  currency?: string;
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
  /** Бюджет попыток chunk↔verify из набора гейтов — знаменатель «осталось K из B». */
  attemptBudget: number;
  usage: Usage;
  /**
   * Сколько решений ждёт человека прямо сейчас: нерешённые одобрения + нерешённые
   * вопросы + красный вердикт (как один пункт). Считает сервер — тот же счёт, что у
   * очереди решений RunPage, а не пересчёт клиента по ленте.
   */
  waiting: number;
  /** Момент старта текущего этапа, epoch ms — для «выполняется X мин». `null` — этап не идёт. */
  stageStartedAt: number | null;
  /** Начало текущего ожидания оператора, epoch ms; null — ожидания нет. */
  awaitingSince?: number | null;
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
  /**
   * Первая содержательная строка intent.md — текст задачи одной строкой. `undefined` —
   * intent не начат или в нём нет текста. Читается с диска при сканировании истории,
   * чтобы «начать похожий виток» подставлял задачу, а не только slug.
   */
  requirement?: string;
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
  /** Рантайм вернул стёртое поле решения человека — вход уже исправлен. То же, что в `tool_request`. */
  repaired?: string;
  /** Метки полей решений, которые стирал исходный вызов до починки. То же, что в `tool_request`. */
  decisionsLost?: string[];
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

/** Агрегат прогонов одного гейта за виток. История не хранится — только счётчики. */
export interface GateMetrics {
  /** Имя гейта как в наборе проекта. */
  gate: string;
  /** Сколько раз гейт запускался (по одному на каждый прогон этапа 6). */
  runs: number;
  /** Сколько раз гейт был ❌. */
  red: number;
  /** Сколько раз гейт был ⏭, будучи включённым в наборе: пропуск включённого гейта —
   *  отдельный сигнал, не смешиваемый с «гейт выключен сознательно». */
  skippedWhileEnabled: number;
  /** Суммарное время прогонов, мс. */
  durationMs: number;
}

/**
 * Улика одной попытки chunk'а — то, что `Run.recordEvidence` УЖЕ посчитал фактически
 * (не заявлением исполнителя), до дорогого `verify`. См. `RunMetrics.chunkEvidence`.
 */
export interface ChunkEvidenceMetric {
  chunk: number;
  attempt: number;
  /** Гейт «Тесты», прогнанный тем же путём, что и на этапе 6 (`Run.recordEvidence`). */
  testsStatus: GateStatus;
  /** Дерево изменилось за попытку — `false` означает «правки не было» (`TreeChange`). */
  treeChanged: boolean;
  /**
   * Гейт «Scope: файлы вне плана» уже красный на этом chunk'е — тем же
   * детерминированным кодом, что и на этапе 6, без LLM. Именно нарушение области:
   * красный «пути плана без правок» сюда НЕ входит (он краснеет и при нуле применённых
   * правок — это не нарушение scope, см. `planPathsUntouched`).
   */
  scopeViolation: boolean;
  /**
   * Гейт «Scope: пути плана без правок» красный: планные пути не получили правок.
   * Отдельный сигнал от `scopeViolation`, чтобы «нет правок» не шумело как нарушение
   * области. Отсутствует в метриках, записанных до появления флага.
   */
  planPathsUntouched?: boolean;
}

/** Трение витка о человека по этапам: сколько раз этап ждал решения или ответа. */
export interface HumanMetrics {
  stage: StageId;
  /** Сколько вопросов человеку задано и отвечено на этом этапе. */
  questions: number;
  /** Сколько вызовов оператор одобрил на этом этапе. */
  approvals: number;
  /** Суммарное время ожидания решений оператора, мс. */
  waitMs: number;
}

/** Артефакт с незакрытыми плейсхолдерами `‹…›` на момент записи метрик. */
export interface ArtifactGap {
  /** Имя файла артефакта в каталоге витка. */
  artifact: string;
  /** Сколько незаполненных мест осталось. Ноль здесь не бывает: счётчик сбросился — строка ушла. */
  placeholders: number;
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
    /**
     * Длительность КАЖДОГО запроса к модели этого этапа, мс, по порядку — не сумма
     * (`durationMs` уже сумма). Нужна отдельно: `Usage.durationMs` складывается через
     * `addUsage` и не умеет отвечать на вопрос «а не завис ли ОДИН запрос», который
     * решает судьбу рецензента иначе, чем сумма (`docs/proposals/reviewer-qualification.md`,
     * критерий 2: один зависший запрос на 20 минут сжигает получасовой бюджет этапа, а
     * средняя/суммарная длительность этого не покажет). Старый снапшот `metrics.json` этого
     * поля не несёт — читается пустым массивом, как и остальные поля этой секции.
     */
    requestDurationsMs: number[];
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
  /**
   * Гейт-агрегаты витка: свёрнутые итоги прогонов, а не история. Репликации истории здесь
   * нет — те же прогоны детально видны в ленте событий и `iterations.md`.
   *
   * Все три поля ниже появились после старых снапшотов `metrics.json`: читатели обязаны
   * считать отсутствующее пустым массивом, а не ломаться.
   */
  gates: GateMetrics[];
  /** Трение о человека по этапам. Пусто — виток ни разу не ждал оператора. */
  human: HumanMetrics[];
  /** Артефакты с незакрытыми `‹…›` на момент записи метрик. */
  artifactGaps: ArtifactGap[];
  /**
   * Улики попытки chunk'а — то, что рантайм УЖЕ считает фактически (`Run.recordEvidence`,
   * тот же гейт «Тесты» и те же Scope-гейты, что и на этапе 6), но раньше это оставалось
   * только текстом в ленте событий и в `chunk-N-attempt-K-tests.txt`, не структурой.
   *
   * По одной записи на попытку chunk'а. Отдельно от `gates` (которые считают ТОЛЬКО
   * прогоны `runGates` этапа 6) — здесь дешёвый, безмодельный сигнал ДО дорогого verify:
   * найдено разбором двух `escalate` у `ministral3-14b-instruct-ctx32k` (docs/model-runs.md
   * → «Серия 5×5»), где рантайм уже знал «Тесты ❌»/scope-нарушение до старта verify, но
   * это не было видно без чтения сырой трассы. Не влияет на `stage_done` chunk'а и не
   * блокирует попытку — только видимость (см. комментарий в `evidence.ts`: «улика говорит
   * правду, судит verify»). Появилось после старых снапшотов `metrics.json` — читатели
   * обязаны считать отсутствующее пустым массивом.
   */
  chunkEvidence: ChunkEvidenceMetric[];
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

export interface PreparationSummary {
  version: 2 | 3;
  canonical?: {
    requirements?: {
      documentHash: string;
      acceptance: { id: string; behavior: string; procedure: string; expected: string }[];
      basis: { id: string; basis: string; scenario: string; counterexample: string }[];
      constraints: { inScope: string[]; outOfScope: string[]; invariants: string[]; assumptions: string[]; questions: string[] };
    };
    plan?: {
      documentHash: string;
      approach: string;
      filesToTouch: string[];
      fileRoles: { path: string; roles: ('source' | 'target' | 'forbidden' | 'new')[] }[];
      steps: { n: number; title: string; file: string; filePaths: string[]; isNew: boolean; symbol: string | null; isNewSymbol: boolean; action: string; claims: string[]; check: string | null; expect: string | null; checkSpecified: boolean; contractChange: string | null; contractSpecified: boolean; dependsOn: number[]; dependenciesSpecified: boolean; facts: string | null; explicit: boolean }[];
    };
  };
  fingerprint: string;
  revision: number;
  confirmed: boolean;
  readyToApprove: boolean;
  issues: string[];
  requirements: string;
  changes: { section: string; before: string; after: string }[];
}

export interface RunDetail extends RunSummary {
  executionMode?: import('./guided.ts').ExecutionMode;
  guided?: import('./guided.ts').GuidedSummary | null;
  preparation?: PreparationSummary | null;
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

// ---------------------------------------------------------------------------
// Dashboard: все запуски всех проектов плюс прогоны стенда
// ---------------------------------------------------------------------------

/**
 * Откуда виток. `ui` — раннер (живой в памяти, либо на диске есть его лента/служебные
 * файлы), `terminal` — только канонические артефакты скиллов `/sdlc-*`, `bench` — файл
 * результата стенда. Признак косвенный: виток, начатый в терминале и продолженный здесь,
 * честно становится `ui` — «смешанного» источника нет, формат артефактов общий.
 */
export const DASHBOARD_SOURCES = ['ui', 'terminal', 'bench'] as const;
export type DashboardSource = (typeof DASHBOARD_SOURCES)[number];

/** Адрес карточки — один тип на hash клиента и URL ручек. У bench `project` = `results`. */
export interface DashboardCardRef {
  source: DashboardSource;
  project: string;
  slug: string;
}

/** Проект-«каталог» стенда в адресе карточки bench. */
export const DASHBOARD_BENCH_PROJECT = 'results';

/**
 * Проект архива стенда: `bench/archive/{results,traces}` той же раскладки — старые прогоны,
 * вытесненные эталоном и новыми (`npm run bench:archive`). На доске скрыт, пока его не
 * выбрали фильтром проекта: сотни старых карточек заслоняли текущую картину.
 */
export const DASHBOARD_BENCH_ARCHIVE = 'archive';

/**
 * Состояние этапа на карточке — факт с диска (ленты, стенда), а не вывод клиента.
 * `blocked` — вход этапа не выполнен (есть блокеры), `notStarted` — ни следа этапа.
 */
export type DashboardStageState = 'done' | 'running' | 'skipped' | 'blocked' | 'notStarted' | 'failed';

export type ArtifactPresence = 'missing' | 'placeholders' | 'filled';

export interface DashboardArtifact {
  /** Имя относительно `.sdlc/<slug>/` (`plan.md`, `.runner/iterations.md`) либо `gates.md`. Ключ `…/artifact?name=`. */
  name: string;
  presence: ArtifactPresence;
  placeholders: number;
  sizeBytes: number | null;
  /** ISO-момент последней правки; `null` — файла нет. */
  mtime: string | null;
  /** Для входов — `StageInput.optional`; для выходов всегда `false`. */
  optional: boolean;
  /** Для входов — назначение артефакта в решениях этого этапа. */
  purpose?: string;
  /** Provenance for stage I/O contracts. */
  origin?: StageId | 'operator' | 'project' | 'runtime';
  freshness?: 'current-run' | 'approved' | 'attempt' | 'live';
  /** Слот решения человека в этом артефакте (`StageDef.humanGate`); `null` — слота нет. */
  decision: { label: string; state: 'granted' | 'declined' | 'pending' } | null;
}

export interface DashboardStage {
  id: StageId;
  title: string;
  state: DashboardStageState;
  /** Этап-виновник блокировки (`stageProducing` / `blamedStage` стенда). */
  blamed: StageId | null;
  /** Короткая причина: пропуск, первый блокер, итог последнего прогона. */
  note: string | null;
  /** Артефакты, которые этап производит (`produces`). */
  outputs: DashboardArtifact[];
  /** Runtime facts injected by the stage module, with purpose and freshness. */
  runtimeFacts?: { id: string; purpose: string; freshness: 'current-run' | 'approved' | 'attempt' | 'live' }[];
}

/** Проект конфига. Несколько имён на один корень сводятся в один ref: витки на диске одни. */
export interface DashboardProjectRef {
  /** Первое имя конфига с этим корнем — сегмент адреса карточки. */
  key: string;
  /** Все имена конфига с этим корнем. */
  aliases: string[];
  projectRoot: string;
}

export interface DashboardBenchRef {
  model: string;
  task: string;
  mode: { kind: 'all' } | { kind: 'stage'; stage: StageId };
  /** Модель по этапам, как её записал стенд. */
  routes: Partial<Record<StageId, string>>;
  /** Причина остановки драйвера стенда — строкой: словарь стенда сервер не импортирует. */
  stopped: string;
  finalVerdict: Verdict | null;
  startedAt: string;
  finishedAt: string;
  hasTrace: boolean;
  hasReport: boolean;
  /**
   * Прогон идёт прямо сейчас: `result.json` стенд пишет только в конце, и идущий прогон
   * виден лишь по `traces/<slug>/progress.log` и живой рабочей копии во временном каталоге.
   */
  inProgress: boolean;
}

export interface DashboardCard {
  ref: DashboardCardRef;
  /** Строка задачи из `intent.md` (витки) либо id задачи стенда. */
  requirement?: string;
  status: HistoryStatus;
  /** ISO-момент последнего изменения. */
  updatedAt: string;
  chunk: number;
  attempt: number;
  /** Все семь этапов в `STAGE_ORDER`. */
  stages: DashboardStage[];
  /** Расход витка; `null` — чисел нет (терминальный виток). */
  usage: Usage | null;
  currency?: string;
  /** Живой прогон в памяти сервера — открывается в `#/run/<runId>`. Только у `ui`. */
  live: RunSummary | null;
  bench: DashboardBenchRef | null;
  /** Сколько раз виток запускался раннером (`run_started` в ленте). 0 — ленты нет. */
  runCount: number;
}

export interface DashboardResponse {
  serverNow: number;
  cards: DashboardCard[];
  /** `available: false` — каталога стенда на этой машине нет; `skipped` — неразобранные файлы. */
  bench: { available: boolean; skipped: number };
}

export interface DashboardStageRun {
  runId: string;
  flow: FlowId | null;
  provider: string | null;
  model: string | null;
  /** Промпт этапа как ушёл в модель; схемы инструментов не отдаются — только имена. */
  prompt: { system: string; user: string; toolNames: string[]; editedByOperator: boolean } | null;
  /** Склейка текстов ответа модели за прогон. */
  assistantText: string;
  gates: GateRunResult[];
  verdict: Verdict | null;
  outcome: { ok: boolean; note: string } | null;
  warnings: string[];
  errors: string[];
  toolCalls: number;
}

export interface DashboardStageDetail extends DashboardStage {
  /** Что этап читает на входе (`stageInputs`). */
  inputs: DashboardArtifact[];
  blockers: { text: string; blamed: StageId | null }[];
  /** Блокеры объявленного обрыва — только у handoff. */
  abortBlockers: { text: string; blamed: StageId | null }[] | null;
  /** Последний прогон этапа по ленте; `null` — в ленте этапа нет (терминал, стенд без трассы). */
  lastRun: DashboardStageRun | null;
  /** Расход этапа из числа витка. */
  metrics: { runs: number; usage: Usage; durationMs: number } | null;
  /**
   * Вердикт рантайма текущей попытки (verify/handoff). `null` — на ЭТОЙ машине вердикта нет:
   * терминальный виток или состояние рантайма другой машины. Строка `passed:` отчёта не
   * читается — это копия для человека, её пишет и модель.
   */
  storedVerdict: { passed: boolean; action: VerdictAction; reasons: string[]; committedSha: string | null } | null;
  /** Запись драйвера стенда по этапу (последняя). */
  benchRecord: {
    ok: boolean;
    note: string;
    timedOut: boolean;
    skipped: boolean;
    envFailure: string | null;
    turns: number | null;
    modelRequests: number | null;
    closedBy: 'runtime' | null;
  } | null;
}

export interface DashboardDetail {
  card: DashboardCard;
  serverNow: number;
  stages: DashboardStageDetail[];
  iterations: IterationSummary[];
  metrics: RunMetrics | null;
  runIds: string[];
  /** Всё, что отдаёт `…/artifact?name=`: артефакты витка, служебные отчёты, файлы стенда. */
  artifacts: DashboardArtifact[];
}

export interface DashboardArtifactResponse {
  name: string;
  text: string;
  placeholders: number;
  sizeBytes: number;
  /** Файл больше потолка чтения — отдан кусок. */
  truncated: boolean;
  /** Отдан конец файла, а не начало: у растущих логов важен хвост. */
  tail: boolean;
}

/**
 * Машинное состояние прогона стенда — `bench/traces/<slug>/run-state.json`.
 *
 * Пишет стенд (`bench/src/runState.ts`), читает дашборд. Контракт вместо разбора
 * `progress.log`: тот лог — для человека, его формат меняется без оглядки, путь рабочей
 * копии в нём виден только в тексте сообщений рантайма, а «процесс жив» по нему выводился
 * лишь из давности правки. Здесь — pid процесса, путь рабочей копии, отметки этапов и
 * момент, когда результат уже записан.
 */
export const BENCH_RUN_STATE_FILE = 'run-state.json';

/** Период пульса прогона стенда; пульс старше трёх периодов — процесса нет. */
export const BENCH_HEARTBEAT_MS = 30_000;

export interface BenchRunState {
  version: 1;
  slug: string;
  model: string;
  task: string;
  /** Процесс стенда — по нему дашборд отличает идущий прогон от убитого. */
  pid: number;
  /**
   * Машина стенда: pid осмыслен только на ней. Сервер на другой машине или в контейнере
   * (чужое пространство pid) судит о жизни прогона по `heartbeatAt`.
   */
  host: string;
  /**
   * Последний «пульс» процесса (раз в `BENCH_HEARTBEAT_MS`). pid на Windows быстро
   * переиспользуется: убитый прогон, чей pid занял чужой процесс, без пульса выглядел бы
   * живым вечно. Жив — это pid жив И пульс свежий.
   */
  heartbeatAt: string;
  /** Этап, с которого начал драйвер: после точки снимка либо intent. Этапы раньше — «из снимка». */
  startStage: StageId;
  /** Валюта маршрута каждого этапа — стоимость не складывается из рублей и долларов. */
  currencies: Partial<Record<StageId, string>>;
  /** Корень рабочей копии (`%TEMP%/sdlc-bench-*`), где живёт `.sdlc/<slug>/`. */
  workspace: string;
  startedAt: string;
  mode: { kind: 'all' } | { kind: 'stage'; stage: StageId };
  routes: Partial<Record<StageId, string>>;
  measured: StageId[];
  /** Отметки этапов по порядку: начат / закрыт успешно / закрыт неуспешно. */
  stages: { stage: StageId; kind: 'start' | 'ok' | 'fail'; at: string; chunk: number; attempt: number; note?: string }[];
  /**
   * Конец прогона. `stopped` — причина остановки драйвера (`handoff`, `blocked`, …) либо
   * `exception`; `verdict` — действие финального вердикта. `null` — прогон не закончен.
   */
  end: { at: string; stopped: string; verdict: string | null; message?: string } | null;
  /** `result.json` уже на диске: до этого законченный прогон ещё дописывает итоги. */
  resultWritten: boolean;
  /** Снимок сохранён (`--make-snapshot`): результата у такого прогона не бывает. */
  snapshot: string | null;
}
