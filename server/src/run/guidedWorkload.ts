import { atomicJson } from '../fs/atomicJson.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GuidedWorkload, ModelWork, Usage } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';

const pathOf = (paths: WitokPaths) => join(paths.runnerDir, 'workload.json');
export function readGuidedWorkload(paths: WitokPaths): GuidedWorkload | null {
  if (!existsSync(pathOf(paths))) return null;
  const state = JSON.parse(readFileSync(pathOf(paths), 'utf8')) as GuidedWorkload;
  if (state.version !== 1 || !state.byPurpose || !state.failures) throw new Error('Повреждены метрики нагрузки guided');
  return state;
}

/** Durable workload attribution; never changes routing or counts cached proposals as calls. */
export class GuidedWorkloadStore {
  private readonly paths: WitokPaths;
  private readonly now: () => number;
  constructor(paths: WitokPaths, now: () => number = Date.now) { this.paths = paths; this.now = now; }
  private update(change: (state: GuidedWorkload) => void): void {
    const zero = () => ({ usageEvents: 0, requests: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
    const state = readGuidedWorkload(this.paths) ?? { version: 1, startedAt: new Date(this.now()).toISOString(),
      byPurpose: { proposal: zero(), 'format-repair': zero(), 'semantic-repair': zero(), context: zero(), review: zero(), unclassified: zero() },
      failures: {}, contextCompactions: 0, contextOverflows: 0, unclassifiedUsageEvents: 0, firstMutation: null };
    change(state);
    atomicJson(pathOf(this.paths), state);
  }
  start(): void { this.update(() => {}); }
  usage(usage: Usage, durationMs: number | undefined, work?: ModelWork): void {
    this.update(state => {
      const row = state.byPurpose[work?.purpose ?? 'unclassified'];
      row.usageEvents++; row.requests += work?.requests ?? 0;
      row.inputTokens += usage.inputTokens; row.outputTokens += usage.outputTokens;
      row.durationMs += durationMs ?? usage.durationMs;
      if (!work || work.requests === undefined) state.unclassifiedUsageEvents++;
    });
  }
  event(event: { kind: 'failure' | 'context-compaction' | 'context-overflow' | 'implementation-write'; reason?: string }): void {
    if (event.kind === 'implementation-write') { this.mutation(); return; }
    this.update(state => {
      if (event.kind === 'context-compaction') state.contextCompactions++;
      else if (event.kind === 'context-overflow') state.contextOverflows++;
      else { const reason = event.reason ?? 'unknown'; state.failures[reason] = (state.failures[reason] ?? 0) + 1; }
    });
  }
  mutation(): void {
    this.update(state => {
      if (state.firstMutation !== null) return;
      const rows = Object.values(state.byPurpose);
      state.firstMutation = { at: new Date(this.now()).toISOString(), elapsedMs: Math.max(0, this.now() - Date.parse(state.startedAt)),
        requests: rows.reduce((sum, row) => sum + row.requests, 0), inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), unclassifiedUsageEvents: state.unclassifiedUsageEvents };
    });
  }
}
