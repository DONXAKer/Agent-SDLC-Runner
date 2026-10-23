import { atomicJson } from '../fs/atomicJson.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { StageId, GuidedProgressSummary } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';

const Unit = z.object({
  stage: z.enum(['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff']),
  revision: z.number().int().positive(), dependencies: z.record(z.string(), z.string()),
  status: z.enum(['proposed', 'observed', 'stale']), value: z.unknown(),
});
const Recovery = z.object({ failures: z.number().int().nonnegative(), narrowed: z.boolean(),
  stopped: z.boolean(), kind: z.string(), reason: z.string(), inputHash: z.string(),
  repair: z.object({ raw: z.unknown(), fields: z.array(z.string()) }).optional() });
const State = z.object({ version: z.literal(1), units: z.record(z.string(), Unit),
  recoveries: z.record(z.string(), Recovery), reused: z.number().int().nonnegative() });
export type ProgressState = z.infer<typeof State>;
export type ProgressTicket = { id: string; stage: StageId; revision: number; dependencies: Record<string, string> };
export type RecoveryAction = 'retry' | 'narrow' | 'stop';

/** Object key order does not affect dependency identity; source text stays exact. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const progressHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value)) ?? 'null').digest('hex');
const equal = (a: unknown, b: unknown): boolean => progressHash(a) === progressHash(b);

/** Runtime-owned structured proposals. Acceptance by a parser never means semantic proof.
 * Each completed unit is durable before the next model call; documents are projections.
 * Source hashes are supplied by the executor, which owns access to those sources. */
export class GuidedProgress {
  private readonly path: string;
  private readonly onChange: ((summary: GuidedProgressSummary) => void) | undefined;
  constructor(paths: WitokPaths, onChange?: (summary: GuidedProgressSummary) => void) {
    this.path = join(paths.dir, '.runner', 'progress.json'); this.onChange = onChange;
  }
  read(): ProgressState {
    return existsSync(this.path) ? State.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1, units: {}, recoveries: {}, reused: 0 };
  }
  private save(state: ProgressState): void {
    atomicJson(this.path, state);
    this.onChange?.(this.summary());
  }
  private invalidate(state: ProgressState, id: string): void {
    const pending = [id]; const visited = new Set<string>();
    while (pending.length) {
      const key = pending.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      if (state.units[key]) state.units[key]!.status = 'stale';
      for (const [other, unit] of Object.entries(state.units)) {
        if (`unit:${key}` in unit.dependencies) pending.push(other);
      }
    }
  }
  begin(id: string, stage: StageId, dependencies: Record<string, string>): ProgressTicket {
    const state = this.read(); const unit = state.units[id];
    if (unit && !equal(unit.dependencies, dependencies)) {
      this.invalidate(state, id); delete state.recoveries[id]; this.save(state);
    }
    return { id, stage, dependencies, revision: unit?.revision ?? 0 };
  }
  reuse<T>(ticket: ProgressTicket, parse: (value: unknown) => T): T | null {
    const state = this.read(); const unit = state.units[ticket.id];
    if (!unit || unit.status === 'stale' || !equal(unit.dependencies, ticket.dependencies)) return null;
    for (const [name, hash] of Object.entries(unit.dependencies)) {
      if (name.startsWith('unit:')) {
        const parent = state.units[name.slice(5)];
        if (!parent || parent.status === 'stale' || progressHash(parent.value) !== hash) return null;
      }
    }
    try { const value = parse(unit.value); state.reused++; this.save(state); return value; }
    catch { this.invalidate(state, ticket.id); this.save(state); return null; }
  }
  accept(ticket: ProgressTicket, value: unknown, currentDependencies: Record<string, string>, observed = false): void {
    if (!equal(ticket.dependencies, currentDependencies)) throw new Error(`Источники ${ticket.id} изменились во время ответа; предложение устарело`);
    const state = this.read(); const previous = state.units[ticket.id];
    if ((previous?.revision ?? 0) !== ticket.revision) throw new Error(`Конфликт версии ${ticket.id}; сохранён более новый ответ`);
    for (const [name, hash] of Object.entries(currentDependencies)) {
      if (!name.startsWith('unit:')) continue;
      const parent = state.units[name.slice(5)];
      if (!parent || parent.status === 'stale' || progressHash(parent.value) !== hash)
        throw new Error(`Зависимость ${name} изменилась; предложение ${ticket.id} устарело`);
    }
    if (previous && !equal(previous.value, value)) this.invalidate(state, ticket.id);
    state.units[ticket.id] = { stage: ticket.stage, revision: ticket.revision + 1,
      dependencies: ticket.dependencies, status: observed ? 'observed' : 'proposed', value };
    delete state.recoveries[ticket.id]; this.save(state);
  }
  reject(ticket: ProgressTicket, kind: string, reason: string): RecoveryAction {
    const state = this.read(); const inputHash = progressHash(ticket.dependencies);
    this.invalidate(state, ticket.id);
    const prior = state.recoveries[ticket.id];
    // Count failures for this unresolved unit, even if the model changes its wording.
    const failures = (prior?.inputHash === inputHash ? prior.failures : 0) + 1;
    const action: RecoveryAction = failures <= 2 ? 'retry' : failures === 3 ? 'narrow' : 'stop';
    state.recoveries[ticket.id] = { failures, narrowed: failures >= 3, stopped: action === 'stop', kind,
      reason: reason.slice(0, 2000), inputHash };
    this.save(state); return action;
  }
  discard(id: string): void {
    const state = this.read(); this.invalidate(state, id); this.save(state);
  }
  clearRecovery(id: string): void {
    const state = this.read();
    if (!state.recoveries[id]) return;
    delete state.recoveries[id]; this.save(state);
  }
  stopRecovery(ticket: ProgressTicket, kind: string, reason: string): void {
    const state = this.read(); this.invalidate(state, ticket.id);
    state.recoveries[ticket.id] = { failures: Math.max(1, state.recoveries[ticket.id]?.failures ?? 0),
      narrowed: true, stopped: true, kind, reason: reason.slice(0, 2000), inputHash: progressHash(ticket.dependencies) };
    this.save(state);
  }
  rememberRepair(ticket: ProgressTicket, raw: unknown, fields: string[]): void {
    const state = this.read();
    const recovery = state.recoveries[ticket.id];
    if (!recovery || recovery.inputHash !== progressHash(ticket.dependencies)) throw new Error('Контекст восстановления изменился');
    recovery.repair = { raw, fields }; this.save(state);
  }
  stop(ticket: ProgressTicket, kind: string, reason: string): void {
    const state = this.read();
    const inputHash = progressHash(ticket.dependencies);
    const previous = state.recoveries[ticket.id];
    state.recoveries[ticket.id] = { failures: previous?.inputHash === inputHash ? previous.failures : 0,
      narrowed: previous?.inputHash === inputHash && previous.narrowed, stopped: true, kind, reason, inputHash };
    this.invalidate(state, ticket.id); this.save(state);
  }
  summary() {
    const state = this.read();
    return { proposed: Object.values(state.units).filter(u => u.status === 'proposed').length,
      observed: Object.values(state.units).filter(u => u.status === 'observed').length,
      stale: Object.values(state.units).filter(u => u.status === 'stale').length, reused: state.reused,
      units: Object.entries(state.units).map(([id, unit]) => ({ id, stage: unit.stage, status: unit.status, revision: unit.revision })),
      recoveries: Object.fromEntries(Object.entries(state.recoveries).map(([id, { repair: _repair, ...recovery }]) => [id, recovery])) };
  }
}
