import type { StageId } from './types.ts';

/** 1: existing guided; 2: durable progress; 3: runtime prerequisites; 4: checked contracts and invariants. */
export type GuidedEngineVersion = 1 | 2 | 3 | 4 | 5;
export const hasGuidedContracts = (version: number | undefined): boolean => version === 4 || version === 5;
export interface GuidedProgressSummary {
  proposed: number;
  observed: number;
  stale: number;
  reused: number;
  units: { id: string; stage: StageId; status: 'proposed' | 'observed' | 'stale'; revision: number }[];
  recoveries: Record<string, { failures: number; narrowed: boolean; stopped: boolean; kind: string; reason: string; inputHash: string }>;
}
