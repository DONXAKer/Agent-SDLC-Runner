/**
 * Типы, общие для сервера и UI.
 *
 * Живут в отдельном пакете, потому что копия этих объявлений в вебе уже разъехалась
 * с серверной за один коммит: web-версия `Route` потеряла `providerDef`, а `describeCall`
 * существовал в двух редакциях с разным текстом. Единственная форма вызова инструмента —
 * `NormalizedCall` — обязана быть буквально одной, иначе утверждение «политика и UI видят
 * одно и то же» перестаёт быть правдой.
 */

export type StageId =
  | 'intent'
  | 'explore'
  | 'ask'
  | 'plan'
  | 'chunk'
  | 'verify'
  | 'handoff';

export const STAGE_ORDER: readonly StageId[] = [
  'intent',
  'explore',
  'ask',
  'plan',
  'chunk',
  'verify',
  'handoff',
] as const;

export type ToolName =
  | 'Read'
  | 'Glob'
  | 'Grep'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'AskHuman'
  | 'FinalizeArtifact'
  /**
   * Запуск субагента. Нужен там, где методология требует независимого исполнителя:
   * `sdlc-locator` на этапе 5 (read-only по построению) и `sdlc-reviewer` на этапе 6
   * («автор не рецензирует себя»). Вызовы инструментов внутри субагента проходят через
   * тот же гейт, поэтому право на Task не расширяет права этапа.
   */
  | 'Task'
  /**
   * Просьба расширить `plan.files_to_touch` посреди chunk'а — законный путь для файла,
   * понадобившегося по ходу правки и не бывшего в плане, вместо тихого нарушения scope
   * или полной остановки chunk'а. Решает **только человек** — см. `RequestScopeExtension`
   * в `matchesRule` (`policy/index.ts`): автоодобрение `rest` на неё не распространяется.
   */
  | 'RequestScopeExtension'
  /**
   * Читающие вызовы внешних MCP-серверов. Идут без шага человека — как `Read` и `Grep`.
   *
   * Права на MCP выражены двумя токенами, а не одним, из-за сужения прав субагента: оно
   * работает пересечением имён из YAML-шапки агента с правами этапа (`Run.onToolRequest`,
   * `LoopExecutor`). С единственным токеном `sdlc-locator`, объявленный read-only по
   * построению, получил бы вместе с `asset_exists` ещё и `delete_asset`.
   */
  | 'McpRead'
  /** Изменяющие вызовы внешних MCP-серверов: только через одобрение оператора. */
  | 'McpWrite';

/**
 * Инструменты со статической схемой — те, что раннер описывает сам (`TOOL_SPECS`).
 *
 * MCP-инструменты сюда не входят намеренно: их схемы приходят из `tools/list` живого
 * сервера, а имена — от него же, и придумать для них запись в закрытой таблице нельзя.
 */
export type BuiltinToolName = Exclude<ToolName, 'McpRead' | 'McpWrite'>;

export type FlowId = 'sdk' | 'loop';

/**
 * Статус ПОСЛЕДНЕГО ЭТАПА прогона, а не витка целиком.
 *
 * Рантайм выставляет его в конце каждого этапа, поэтому `done` означает «последний этап
 * прошёл», а не «виток закончен»: у витка из семи этапов такой статус наступает уже после
 * `intent`. Отдельного состояния «виток закончен» в рантайме нет — закончил ли виток,
 * видно по артефактам на диске. Тип живёт в общем пакете, чтобы полнота словарей статуса
 * на стороне интерфейса проверялась сборкой, а не глазами.
 */
export type RunStatus = 'idle' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// Нормализованный вызов инструмента
// ---------------------------------------------------------------------------

export interface EditOp {
  oldStr: string;
  newStr: string;
  replaceAll: boolean;
}

export interface Question {
  id: string;
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/**
 * `writeTargets` у bash здесь намеренно НЕТ: поле, которое всегда пусто, — ловушка.
 * Цели записи считает политика и кладёт их в событие `tool_request`, чтобы оператор
 * видел, во что команда запишет, а следующий разработчик не принял пустой массив
 * за посчитанный ответ.
 */
export type NormalizedCall =
  | {
      kind: 'read';
      path: string;
      /**
       * Диапазон строк, включающий. `to: null` — «до конца файла».
       *
       * Именно `null`, а не «очень большое число»: `Number.MAX_SAFE_INTEGER` утекал в
       * карточку одобрения («строки 10–9007199254740991») и, что хуже, делал такой вызов
       * неотличимым от настоящего диапазона — предохранитель, требующий читать большой
       * файл частями, пропускал чтение всего файла целиком.
       */
      range: { from: number; to: number | null } | null;
    }
  | { kind: 'glob'; pattern: string; path: string | null }
  | { kind: 'grep'; pattern: string; path: string | null }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; edits: EditOp[] }
  | { kind: 'bash'; command: string }
  | { kind: 'ask_human'; questions: Question[] }
  | { kind: 'finalize_artifact'; artifact: string; note: string | null }
  | { kind: 'subagent'; agent: string; prompt: string }
  | { kind: 'request_scope_extension'; path: string; reason: string }
  /**
   * Вызов инструмента внешнего MCP-сервера.
   *
   * Класса «читает или пишет» здесь намеренно НЕТ. Он берётся из разрешительного списка
   * оператора (`PolicyContext.mcpTools`), а не из вызова: продублированный тут, он разошёлся
   * бы со списком молча — ровно тот класс ловушки, из-за которого у `bash` нет поля
   * `writeTargets`.
   *
   * `args` кладутся дословно: схем сотен внешних инструментов нормализатор не знает, и
   * «тихо выбросил непонятный ключ» здесь было бы потерей аргумента, а не нормализацией.
   */
  | { kind: 'mcp'; server: string; tool: string; args: Record<string, unknown> }
  /** Инструмент, которого мы не знаем. Политика считает его записью — по худшему случаю. */
  | { kind: 'unknown'; toolName: string; raw: unknown };

export type CallKind = NormalizedCall['kind'];

/**
 * Все виды вызова списком — чтобы про новый вид нельзя было забыть молча.
 *
 * Половина модулей политики и предпросмотр разбирают `NormalizedCall` через `switch` с
 * `default`, то есть новый `kind` их не ломает: он через них просто проходит. Этот массив
 * существует ради теста, который перебирает виды и требует, чтобы автор отнёс каждый к
 * «проверяется» или «намеренно пропускается»; `satisfies` стережёт его полноту.
 */
export const CALL_KINDS = Object.keys({
  read: true,
  glob: true,
  grep: true,
  write: true,
  edit: true,
  bash: true,
  ask_human: true,
  finalize_artifact: true,
  subagent: true,
  request_scope_extension: true,
  mcp: true,
  unknown: true,
} satisfies Record<CallKind, true>) as readonly CallKind[];

// ---------------------------------------------------------------------------
// Политика доступа
// ---------------------------------------------------------------------------

export type PolicyName = 'pathScope' | 'denyList' | 'planScope' | 'stageTools' | 'repeatFailure';

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; policy: PolicyName; reason: string };

export const POLICY_OK: PolicyVerdict = { ok: true };

export function policyDeny(policy: PolicyName, reason: string): PolicyVerdict {
  return { ok: false, policy, reason };
}

/**
 * Правила автоодобрения на этап.
 *
 * Заменяют тумблер «одобрять всё»: он был единственным способом не сидеть над каждым
 * вызовом, и включавший его оператор соглашался в том числе на `Bash` и на запись вне
 * плана — то есть ровно на то, ради чего гейт и существует.
 */
export interface AutoApproveRules {
  /** Правки, ВСЕ цели которых лежат в `files_to_touch` одобренного плана. */
  planWrites: boolean;
  /** Команды оболочки. Отдельно: их цели записи считает лексер, а не заявляет вызов. */
  bash: boolean;
  /** Всё остальное, включая запись вне плана. */
  rest: boolean;
  /**
   * Изменяющие вызовы внешних MCP-серверов. Отдельным флагом, а не в `rest`: этап 5 с
   * редактором — это десятки правок подряд, а `rest` означает ещё и запись вне плана.
   * Оператор, включивший его ради темпа, молча подписался бы на `delete_asset`.
   */
  mcpWrites: boolean;
}

export const AUTO_APPROVE_OFF: AutoApproveRules = {
  planWrites: false,
  bash: false,
  rest: false,
  mcpWrites: false,
};

/** Читает инструмент или изменяет состояние. Решает человек — см. `McpToolRule`. */
export type McpMode = 'read' | 'write';

/**
 * Разрешение на один инструмент внешнего MCP-сервера.
 *
 * Класс инструмента задаёт человек в конфиге, а не эвристика по имени и не аннотация
 * сервера. Имя ничего не гарантирует (`tick_world`, `pie_start`, `compile_blueprint`
 * читающими не являются), а `readOnlyHint` — утверждение той самой стороны, которую гейт
 * и сторожит.
 */
export interface McpToolRule {
  server: string;
  /** Точное имя инструмента либо префикс с одной завершающей `*`. Шаблон даёт только `write`. */
  tool: string;
  mode: McpMode;
  /**
   * Аргументы, значения которых — НАСТОЯЩИЕ пути файловой системы, и только они уходят
   * в `pathScope`/`denyList`/`planScope`.
   *
   * Пусто по умолчанию, и это решение, а не пробел: `/Game/Cards/BP_Card` — путь ассета
   * Unreal, но `isAbsolute` считает его абсолютным путём диска, и скан «похожих на путь»
   * строк отклонял бы каждый вызов отказом, который оператор снять не может.
   */
  pathArgs: readonly { key: string; access: 'read' | 'write' }[];
}

export interface PolicyContext {
  /** Абсолютный нормализованный корень целевого проекта. */
  projectRoot: string;
  /** Этап, на котором сделан вызов — права выдаются на шаг. */
  stage: StageId;
  /** Каталог артефактов витка относительно корня, например `.sdlc/pay-412`. */
  sdlcDir: string;
  /**
   * Пути из `plan.files_to_touch`, нормализованные относительно корня.
   * `null` — PlanScope ещё не действует (виток не дошёл до одобренного плана).
   */
  planFiles: readonly string[] | null;
  /**
   * Артефакты, которые агенту нельзя переписывать на этом этапе, даже внутри `.sdlc`.
   * Сюда попадают решения человека и набор гейтов: агент, который может переписать
   * одобренный план, может и расширить себе allowlist.
   */
  protectedArtifacts: readonly string[];
  /**
   * Каталоги вне проекта, открытые только на чтение: формы методологии и тексты
   * этапов. Промпт прямым текстом велит их читать, так что запрет на это ломал бы
   * виток на первом же шаге.
   */
  readOnlyRoots: readonly string[];
  /** Инструменты, разрешённые на текущем этапе. */
  allowedTools: readonly ToolName[];
  /**
   * Разрешительный список MCP-инструментов на этап. Пустой список — MCP не выдан.
   *
   * Не `| null`: у `planFiles` `null` означает «проверка ещё не действует», и то же
   * написание здесь читалось бы как «всё разрешено» — противоположность замыслу.
   */
  mcpTools: readonly McpToolRule[];
}

// ---------------------------------------------------------------------------
// Решение по вызову: политика + человек
// ---------------------------------------------------------------------------

export type Decision =
  | { allowed: true; updatedInput: unknown | null; by: 'policy' | 'operator' | 'auto' }
  | { allowed: false; reason: string; by: 'policy' | 'operator' };

// ---------------------------------------------------------------------------
// Стоимость и токены
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null — маршрут без стоимости (локальная модель), а не «стоимость ноль». */
  costUsd: number | null;
  durationMs: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
    durationMs: a.durationMs + b.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

export interface PreparedPrompt {
  /**
   * Нередактируемый блок, который добавляет исполнитель помимо нашего текста.
   * У флоу `sdk` — системный пресет Claude Code; у `loop` — null, там видно всё.
   */
  presetNote: string | null;
  /** Тело этапа: содержимое SKILL.md + adapter. Редактируется оператором. */
  system: string;
  /** Пользовательское сообщение: артефакты-входы и контекст-пакет. Редактируется. */
  user: string;
  /** JSON-схемы инструментов, которые реально уйдут в запрос. */
  tools: { name: string; description: string; schema: unknown }[];
  /** Промпт отредактирован оператором вручную — видно в журнале прогона. */
  editedByOperator: boolean;
}

// ---------------------------------------------------------------------------
// Вердикт этапа 6
// ---------------------------------------------------------------------------

/** Статусы из таблицы вердикта методологии. */
export type GateStatus = '✅' | '❌' | '⏭';
/**
 * Статус пункта приёмки в отчёте.
 *
 * `manual` — пункт с тегом `[manual]` в задаче: по построению не проверяется этапом 6 и
 * вердикт не роняет, а переносится в `handoff.md` как открытая ручная проверка. Не путать
 * с `⚠`: тот про НЕсостоявшуюся автоматическую проверку, `manual` — про проверку, которой
 * на этом этапе и не должно было быть. Пока значения не существовало, разбор отчёта не
 * узнавал слово «manual» в ячейке, ставил `⚠` и ронял вердикт ровно на том пункте, который
 * методология освобождает от автоматики (находка M2 ретро 2026-08-27).
 */
export type ClaimStatus = '✅' | '❌' | '⚠' | 'manual';

/**
 * Строгость статуса гейта: чем больше число, тем хуже исход.
 *
 * `⏭` строже `✅`, потому что «не запускался» роняет вердикт, а `❌` строже всего.
 */
const GATE_SEVERITY: Record<GateStatus, number> = { '✅': 0, '⏭': 1, '❌': 2 };

/**
 * Худший из двух статусов гейта — одно правило на всю кодовую базу.
 *
 * Берётся ХУДШИЙ, а не «источник X всегда прав»: правило «побеждает прогон» защищало от
 * рецензента, перекрашивающего красное в зелёное, но работало и в обратную сторону —
 * рецензент ставил `❌`, найдя расхождение, а фиктивный «прогон» гейта перебивал его
 * зелёным. То же правило нужно там, где один гейт проверяет несколько модулей: `✅`
 * допустим, только если проверены все.
 */
export function worstGateStatus(a: GateStatus, b: GateStatus): GateStatus {
  return GATE_SEVERITY[a] >= GATE_SEVERITY[b] ? a : b;
}

/**
 * Строгость статуса пункта приёмки. `⚠` хуже `✅`, `❌` хуже всего.
 *
 * Нужен там же, где и `worstGateStatus`: когда один и тот же пункт оценили несколько
 * рецензентов ансамбля, в вердикт идёт худшая из оценок — иначе достаточно одного слабого
 * рецензента, чтобы зелёный перебил найденный дефект.
 */
// `manual` мягче зелёного намеренно: если один маршрут ансамбля счёл пункт ручным, а другой
// сумел его доказать, в свод идёт доказательство. Обратное («ручной перебивает зелёный»)
// прятало бы состоявшуюся проверку за пометкой.
const CLAIM_SEVERITY: Record<ClaimStatus, number> = { manual: -1, '✅': 0, '⚠': 1, '❌': 2 };

export function worstClaimStatus(a: ClaimStatus, b: ClaimStatus): ClaimStatus {
  return CLAIM_SEVERITY[a] >= CLAIM_SEVERITY[b] ? a : b;
}
/**
 * Что делать после вердикта.
 *
 * `blocked_env` — красный из-за окружения: гейт не смог ЗАПУСТИТЬСЯ (нет инструмента, нет
 * докера, нет прав), и его код возврата свидетельствует о машине, а не о работе. Методология
 * (`SDLC.md` → этап 6, «Красный из-за окружения») требует отличать его от `retry` в двух
 * местах: чинится он вне витка, и номер попытки он не занимает — следующая строка журнала
 * получает тот же `K`. Пока значения не было, каждый такой красный съедал попытку из бюджета
 * (находка M1 ретро 2026-08-27).
 */
export type VerdictAction = 'continue' | 'retry' | 'escalate' | 'blocked_env';

export interface VerdictInput {
  gates: {
    name: string;
    status: GateStatus;
    inapplicableSignedBy: string | null;
    /** Гейт не смог запуститься из-за среды — см. `GateRunResult.envBlocked`. */
    envBlocked?: boolean;
  }[];
  claims: { id: string; status: ClaimStatus }[];
  /** Условия вне статусов — каждое роняет вердикт само по себе. */
  confirmedReviewFindings: number;
  enabledGatesMissingFromReport: string[];
  openDebtRows: string[];
  brokenInvariants: string[];
  regressions: string[];
  plannedPathsUntouched: string[];
  diffMatchesTree: boolean;
  attempt: number;
  attemptBudget: number;
  /** Два подряд одинаковых diff'а — прогресса нет. */
  noProgress: boolean;
}

export interface Verdict {
  passed: boolean;
  action: VerdictAction;
  /** По каким именно условиям вердикт упал — дословно, для отчёта. */
  reasons: string[];
}

/**
 * Природа красной причины. Классификация отвечает на вопрос «куда возвращать виток» и на
 * `passed` не влияет никак: `❌` остаётся `❌` при любой ветке.
 */
export type RedCauseKind =
  /** Запись за пределы `files_to_touch`: переделывать надо план, а не chunk. */
  | 'scope'
  /** Рецензент разошёлся с фактическим прогоном — ошибка чтения фактов, а не кода. */
  | 'reviewer'
  /** Упал или не запускался гейт — работа на том же этапе. */
  | 'gate'
  /** Пункт приёмки опровергнут или не проверяем. */
  | 'claim'
  /** Инварианты, регрессии, расхождение diff с деревом, долг. */
  | 'integrity';

/**
 * Предложение поднять модель этапа chunk. Предложение, а не переход: смена модели посреди
 * витка меняет стоимость и поведение, и решает это человек.
 */
export type Escalation =
  | { kind: 'none'; why: string }
  | { kind: 'suggest'; toModelId: string; toRank: number; claims: string[]; why: string }
  | { kind: 'blocked'; claims: string[]; why: string };

export interface RedCause {
  kind: RedCauseKind;
  /**
   * Предложение оператору, а не автоматический переход: возврат на план ломает
   * предусловия следующих этапов, и решение о нём принимает человек.
   */
  suggest: 'fix-in-chunk' | 'back-to-plan' | 'escalate-model';
  /** Все найденные причины: победившая первой, остальные следом. */
  why: string[];
}

// ---------------------------------------------------------------------------
// События шины
// ---------------------------------------------------------------------------

export interface DiffPreview {
  path: string;
  /** null — файла ещё нет, это создание. */
  before: string | null;
  after: string;
}

export interface GateRunResult {
  name: string;
  status: GateStatus;
  command: string | null;
  exitCode: number | null;
  lastLine: string;
  durationMs: number;
  /**
   * Гейт не смог ЗАПУСТИТЬСЯ: нет инструмента, вышло время, вызов отклонён политикой.
   *
   * Отдельным полем, а не разбором `lastLine` теми же регулярками во второй раз: причину
   * знает тот, кто её создал, и восстанавливать её потом по тексту — способ разойтись
   * молча. По этому полю вердикт отличает «красный из-за окружения» (чинится вне витка и
   * не занимает номер попытки) от обычного красного.
   */
  envBlocked: boolean;
}

/**
 * Состояние внешнего MCP-сервера.
 *
 * `unavailable` — сервер описан верно, но не отвечает: редактор не запущен, порт закрыт,
 * бинарника нет. Это НЕ ошибка конфигурации и не повод не начинать виток; ошибку описания
 * ловит загрузка конфига, а `invalid` остаётся для файла проекта, который не разобрался.
 */
export type McpServerState = 'disabled' | 'pending' | 'connected' | 'unavailable' | 'invalid';

/** Внешний MCP-сервер так, как его показывают оператору. Секретов здесь нет по построению. */
export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http';
  /** Для http — URL без query, для stdio — имя команды с аргументами. */
  target: string;
  /** Имена ключей `env`/`headers` без значений: что подставляется — видно, что именно — нет. */
  envKeys: readonly string[];
  state: McpServerState;
  /** Почему недоступен, человеческим языком. `null` — доступен. */
  reason: string | null;
  /** Сколько инструментов отдал сервер. `null` — не спрашивали. */
  toolCount: number | null;
  /** Набор, разрешённый на текущем этапе. */
  selected: readonly string[];
  /** Хвост stderr дочернего процесса: единственная диагностика «команда не найдена». */
  stderrTail: string | null;
}

export type RunEvent =
  | { type: 'run_started'; runId: string; slug: string; profile: string; projectRoot: string }
  | {
      type: 'mcp_state';
      runId: string;
      stage: StageId | null;
      server: string;
      state: McpServerState;
      reason: string | null;
      toolCount: number | null;
    }
  | {
      type: 'stage_started';
      runId: string;
      stage: StageId;
      flow: FlowId;
      provider: string;
      model: string;
      chunk: number;
      attempt: number;
    }
  | { type: 'prompt_prepared'; runId: string; stage: StageId; prompt: PreparedPrompt }
  | { type: 'assistant_text'; runId: string; stage: StageId; text: string }
  | { type: 'thinking'; runId: string; stage: StageId; text: string }
  | {
      type: 'tool_request';
      runId: string;
      stage: StageId;
      requestId: string;
      /** Имя инструмента, как его назвал исполнитель. */
      toolName: string;
      /** Аргументы до нормализации — то, что правит оператор и что уйдёт исполнителю. */
      rawInput: Record<string, unknown>;
      call: NormalizedCall;
      policy: PolicyVerdict;
      preview: DiffPreview | null;
      /** Во что запишет команда: посчитано политикой, а не заявлено вызовом. */
      writeTargets: string[] | null;
      /**
       * Перезапись файла целиком с потерей содержимого. `null` — потери нет.
       *
       * В событии, а не только в очереди одобрений: карточка в интерфейсе собирается из
       * ленты, когда сервер о запросе ещё не спрашивали, и без этого поля предупреждение
       * пропадало бы ровно в тот момент, когда оператор решает быстрее всего.
       */
      destructive: string | null;
    }
  | { type: 'tool_resolved'; runId: string; stage: StageId; requestId: string; decision: Decision }
  | {
      type: 'tool_result';
      runId: string;
      stage: StageId;
      requestId: string;
      ok: boolean;
      summary: string;
      durationMs: number;
    }
  | { type: 'usage'; runId: string; stage: StageId; usage: Usage; total: Usage }
  // `stage: null` — артефакт записал человек, а не этап: так выглядит запись решения
  // (одобрение плана, приёмка). Это не «этап неизвестен», это «этап тут ни при чём».
  | {
      type: 'artifact_written';
      runId: string;
      stage: StageId | null;
      path: string;
      placeholders: number;
    }
  | { type: 'gate_result'; runId: string; stage: StageId; gate: GateRunResult }
  | { type: 'verdict'; runId: string; stage: StageId; verdict: Verdict }
  | { type: 'stage_done'; runId: string; stage: StageId; ok: boolean; note: string }
  | { type: 'run_finished'; runId: string; ok: boolean; note: string }
  | { type: 'warning'; runId: string; stage: StageId | null; message: string }
  | { type: 'error'; runId: string; stage: StageId | null; message: string };

export type EventSink = (e: RunEvent) => void;

/**
 * Форматирование стоимости прогона — ОДНО на все поверхности.
 *
 * Ноль стоимости означает разное, и путать эти случаи нельзя: до первого вызова модели
 * тратить ещё нечего, а на локальном маршруте стоимости нет вовсе. «Ещё нечего» — это
 * ноль ПРИ полном отсутствии токенов, включая кэшевые.
 *
 * Живёт в общем пакете, потому что одну и ту же цифру показывают и интерфейс, и пост-виток
 * отчёт в `handoff.md`. Пока копия форматтера лежала в `run/postmortem.ts`, они уже
 * разошлись: при нулевой стоимости и ненулевых токенах шапка печатала `$0`, а артефакт —
 * `$0.0000`.
 *
 * `noCost` — как назвать отсутствие стоимости: в интерфейсе коротко, в артефакте
 * развёрнуто. Это единственное, чем поверхности вправе отличаться.
 */
export function formatCost(usage: Usage, noCost = 'без стоимости'): string {
  if (usage.costUsd === null) return noCost;
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (usage.costUsd === 0 && tokens === 0) return '—';
  if (usage.costUsd === 0) return '$0';
  return `$${usage.costUsd.toFixed(4)}`;
}

/** Длительность в человеческом виде. Одна копия — по той же причине, что и `formatCost`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}
