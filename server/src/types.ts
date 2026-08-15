/**
 * Общие типы рантайма.
 *
 * Ключевой из них — NormalizedCall. Оба флоу исполнения (sdk и loop) приводят
 * вызов инструмента к этой форме ПРЕЖДЕ, чем его увидят политика доступа и UI.
 * Благодаря этому политика существует в одном экземпляре, а не в двух копиях,
 * которые со временем разъедутся.
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
  | 'FinalizeArtifact';

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

export type NormalizedCall =
  | { kind: 'read'; path: string; range: { from: number; to: number } | null }
  | { kind: 'glob'; pattern: string; path: string | null }
  | { kind: 'grep'; pattern: string; path: string | null }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; edits: EditOp[] }
  | { kind: 'bash'; command: string; writeTargets: string[] }
  | { kind: 'ask_human'; questions: Question[] }
  | { kind: 'finalize_artifact'; artifact: string; data: unknown }
  /** Инструмент, которого мы не знаем. Политика считает его записью — по худшему случаю. */
  | { kind: 'unknown'; toolName: string; raw: unknown };

export type CallKind = NormalizedCall['kind'];

/** Вызовы, которые могут изменить дерево проекта. */
export const MUTATING_KINDS: readonly CallKind[] = ['write', 'edit', 'bash', 'unknown'] as const;

export function isMutating(call: NormalizedCall): boolean {
  return MUTATING_KINDS.includes(call.kind);
}

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
  /** Каталог артефактов витка относительно корня, например `.sdlc/pay-412`. */
  sdlcDir: string;
  /**
   * Пути из `plan.files_to_touch`, нормализованные относительно корня.
   * `null` — PlanScope ещё не действует (виток не дошёл до одобренного плана).
   */
  planFiles: readonly string[] | null;
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
  /** null для локальных маршрутов — там стоимости нет, но токены и время считаем. */
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

export type RunEvent =
  | { type: 'run_started'; runId: string; slug: string; profile: string; projectRoot: string }
  | { type: 'stage_started'; runId: string; stage: StageId; flow: FlowId; provider: string; model: string }
  | { type: 'prompt_prepared'; runId: string; stage: StageId; prompt: PreparedPrompt }
  | { type: 'assistant_text'; runId: string; stage: StageId; text: string }
  | { type: 'thinking'; runId: string; stage: StageId; text: string }
  | {
      type: 'tool_request';
      runId: string;
      stage: StageId;
      requestId: string;
      call: NormalizedCall;
      policy: PolicyVerdict;
      preview: DiffPreview | null;
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
  | { type: 'artifact_written'; runId: string; stage: StageId; path: string; placeholders: number }
  | { type: 'stage_done'; runId: string; stage: StageId; ok: boolean; note: string }
  | { type: 'run_finished'; runId: string; ok: boolean; note: string }
  | { type: 'error'; runId: string; stage: StageId | null; message: string };

export type EventSink = (e: RunEvent) => void;
