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
  | 'Task';

export type FlowId = 'sdk' | 'loop';

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
  /** Инструмент, которого мы не знаем. Политика считает его записью — по худшему случаю. */
  | { kind: 'unknown'; toolName: string; raw: unknown };

export type CallKind = NormalizedCall['kind'];

// ---------------------------------------------------------------------------
// Политика доступа
// ---------------------------------------------------------------------------

export type PolicyName = 'pathScope' | 'denyList' | 'planScope' | 'stageTools';

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; policy: PolicyName; reason: string };

export const POLICY_OK: PolicyVerdict = { ok: true };

export function policyDeny(policy: PolicyName, reason: string): PolicyVerdict {
  return { ok: false, policy, reason };
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
export type ClaimStatus = '✅' | '❌' | '⚠';
export type VerdictAction = 'continue' | 'retry' | 'escalate';

export interface VerdictInput {
  gates: { name: string; status: GateStatus; inapplicableSignedBy: string | null }[];
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
}

export type RunEvent =
  | { type: 'run_started'; runId: string; slug: string; profile: string; projectRoot: string }
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
