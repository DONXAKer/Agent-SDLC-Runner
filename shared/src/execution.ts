import type { ModelWorkPurpose } from './guided.ts';

export type OperationKind = 'item' | 'context' | 'proposal' | 'validation' | 'apply' | 'check' | 'diagnosis' | 'repair' | 'rollback';
export interface ExecutionOperation {
  version: 1;
  id: string;
  parentId: string | null;
  itemId: string | null;
  attempt: number;
  kind: OperationKind;
  phase: 'started' | 'finished';
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  durationMs?: number;
  evidence?: unknown;
}
export interface ExecutionEntry {
  id: string;
  at: string;
  invocation: string | null;
  stage: string | null;
  kind: string;
  from: string;
  to: string;
  payload: unknown;
  operationId?: string;
  itemId?: string;
  attempt?: number;
}
export interface ExecutionSummary {
  complete: boolean;
  limitations: string[];
  operations: number;
  active: { id: string; kind: OperationKind; itemId: string | null; startedAt: string; attempt: number }[];
  interrupted: number;
  checks: { passed: number; failed: number; firstAttemptPassed: number; itemsChecked: number };
  repeatedFailures: number;
  rollbacks: number;
  timeToFirstMutationMs: number | null;
  timeToFirstPassingCheckMs: number | null;
  toolDurationMs: number;
  checkDurationMs: number;
  humanWaitMs: number;
  incompleteContexts: number;
  failures: Record<string, number>;
  byPurpose: Partial<Record<ModelWorkPurpose, { requests: number | null; inputTokens: number; outputTokens: number; cost: number | null; currency: string; durationMs: number }>>;
}
export interface ExecutionPage {
  version: 1;
  runId: string;
  entries: ExecutionEntry[];
  nextCursor: number;
  hasMore: boolean;
  summary: ExecutionSummary;
}
