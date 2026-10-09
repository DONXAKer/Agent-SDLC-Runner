/** Runtime-owned progress. A checked item is not yet an accepted task. */
import type { StageId } from './types.ts';

export type ExecutionMode = 'legacy' | 'guided';
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
