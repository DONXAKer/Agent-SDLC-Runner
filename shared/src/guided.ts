/** Runtime-owned progress. A checked item is not yet an accepted task. */
export type ExecutionMode = 'legacy' | 'guided';
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
}
