export type StageId = 'intent' | 'explore' | 'ask' | 'plan' | 'chunk' | 'verify' | 'handoff';
export type FlowId = 'sdk' | 'loop';

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
  | { kind: 'edit'; path: string; edits: { oldStr: string; newStr: string; replaceAll: boolean }[] }
  | { kind: 'bash'; command: string; writeTargets: string[] }
  | { kind: 'ask_human'; questions: Question[] }
  | { kind: 'finalize_artifact'; artifact: string; data: unknown }
  | { kind: 'unknown'; toolName: string; raw: unknown };

export type PolicyVerdict =
  | { ok: true }
  | { ok: false; policy: 'pathScope' | 'denyList' | 'planScope' | 'stageTools'; reason: string };

export type Decision =
  | { allowed: true; updatedInput: unknown | null; by: 'policy' | 'operator' | 'auto' }
  | { allowed: false; reason: string; by: 'policy' | 'operator' };

export interface DiffPreview {
  path: string;
  before: string | null;
  after: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number;
}

export interface PreparedPrompt {
  presetNote: string | null;
  system: string;
  user: string;
  tools: { name: string; description: string; schema: unknown }[];
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

export interface StageInfo {
  id: StageId;
  title: string;
  tools: string[];
  blockers: string[];
  produces: string[];
}

export interface Route {
  stage: StageId;
  modelId: string;
  provider: string;
  model: string;
  flow: FlowId;
  rank: number;
}

export interface RunDetail {
  runId: string;
  slug: string;
  project: string;
  projectRoot: string;
  profile: string;
  routes: Record<StageId, Route>;
  status: string;
  stage: StageId | null;
  chunk: number;
  attempt: number;
  usage: Usage;
  stages: StageInfo[];
  pendingApprovals: {
    runId: string;
    stage: StageId;
    requestId: string;
    call: NormalizedCall;
    policy: PolicyVerdict;
    preview: DiffPreview | null;
  }[];
  pendingQuestions: { runId: string; stage: StageId; requestId: string; questions: Question[] }[];
  events: RunEvent[];
}

export interface ProjectInfo {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  profiles: { name: string; label: string; stages: Record<StageId, string> }[];
}

export interface ConfigInfo {
  operator: string;
  projects: ProjectInfo[];
  models: { id: string; provider: string; model: string; rank: number }[];
  stages: { id: StageId; title: string; tools: string[] }[];
}
