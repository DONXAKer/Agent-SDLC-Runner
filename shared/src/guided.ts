/** Runtime-owned progress. A checked item is not yet an accepted task. */
import type { StageId } from './types.ts';

export type ExecutionMode = 'legacy' | 'guided';
export type ModelWorkPurpose = 'proposal' | 'format-repair' | 'semantic-repair' | 'context' | 'review' | 'unclassified';
export interface ModelWork {
  operationId?: string;
  purpose: ModelWorkPurpose;
  /** Exact provider calls represented by this usage event; absent means unknown. */
  requests?: number;
}
export interface GuidedWorkload {
  version: 1;
  startedAt: string;
  byPurpose: Record<ModelWorkPurpose, { usageEvents: number; requests: number; inputTokens: number; outputTokens: number; durationMs: number }>;
  failures: Record<string, number>;
  contextCompactions: number;
  contextOverflows: number;
  unclassifiedUsageEvents: number;
  firstMutation: { at: string; elapsedMs: number; requests: number; inputTokens: number; outputTokens: number; unclassifiedUsageEvents: number } | null;
}
export interface GuidedFailure {
  kind: 'contract' | 'plan' | 'operation' | 'checks' | 'format' | 'environment';
  origin: StageId;
  retryStage: StageId;
  reason: string;
  pendingFields?: number;
  reviewStatus?: 'pending' | 'rejected' | 'stale';
}
/** Public, auditable decision summaries; not the model's private reasoning. */
export interface StageDecisionCheck {
  stage: StageId;
  at: string;
  inputRevision: string;
  decision: string;
  evidence: { source: string; quote: string }[];
  uncertainties: string[];
  action: 'proceed' | 'read' | 'search' | 'input' | 'question' | 'blocked';
  reason: string;
  status: 'ready' | 'collecting' | 'blocked';
  changed: boolean;
  checkedBy?: 'model' | 'runtime';
  observation?: { source: string; ok: boolean; text: string };
}
export interface WorkItem {
  id: string;
  title: string;
  claims: string[];
  dependsOn: string[];
  files: string[];
  prediction: string;
  checks: string[];
  status: 'pending' | 'running' | 'checked' | 'failed' | 'blocked';
  attempts: number;
  repartitioned: boolean;
  parts?: { title: string; files: string[]; prediction: string }[];
}
export interface Observation {
  itemId: string;
  at: string;
  inputRevision: string;
  codeRevision: string;
  prediction: string;
  result: string;
  kind: 'check' | 'format' | 'context' | 'policy' | 'environment' | 'conflict' | 'repartition';
  passed: boolean;
}
export interface GuidedSummary {
  version: 1;
  /** Absent in historical runs means engine 1. Fixed when creating the task. */
  engineVersion?: import('./guidedProgress.ts').GuidedEngineVersion;
  progress?: import('./guidedProgress.ts').GuidedProgressSummary;
  workload?: GuidedWorkload;
  mode: 'guided';
  modelId: string;
  budgetMs: number;
  activeMs: number;
  remainingMs: number;
  inputRevision: string;
  currentItem: string | null;
  stopReason: string | null;
  items: WorkItem[];
  observations: Observation[];
  decisionChecks?: StageDecisionCheck[];
}
