import { randomUUID } from 'node:crypto';
import type { ExecutionOperation, OperationKind } from '@sdlc-runner/shared';

/** Observations never grant authority or change execution on recorder failure. */
export class ExecutionObserver {
  private stack: string[] = [];
  itemId: string | null = null;
  attempt = 0;
  lastCompletedId: string | undefined;
  private readonly emit: ((event: ExecutionOperation) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  constructor(emit?: (event: ExecutionOperation) => void, signal?: AbortSignal) { this.emit = emit; this.signal = signal; }
  private send(event: ExecutionOperation): void {
    try { this.emit?.(event); } catch { /* The recorder reports its own health. */ }
  }
  start(kind: OperationKind, evidence?: unknown) {
    const base = { version: 1 as const, id: randomUUID(), parentId: this.stack.at(-1) ?? null,
      itemId: this.itemId, attempt: this.attempt, kind };
    const start = performance.now();
    this.stack.push(base.id);
    this.send({ ...base, phase: 'started', status: 'running', evidence });
    let closed = false;
    return (status: 'passed' | 'failed' | 'interrupted', result?: unknown) => {
      if (closed) return;
      closed = true;
      this.lastCompletedId = base.id;
      this.stack = this.stack.filter(id => id !== base.id);
      this.send({ ...base, phase: 'finished', status, durationMs: performance.now() - start, evidence: result });
    };
  }
  sync<T>(kind: OperationKind, action: () => T, evidence?: unknown): T {
    const end = this.start(kind, evidence);
    try { const result = action(); end(result && typeof result === 'object' && 'passed' in result && result.passed === false ? 'failed' : 'passed', result); return result; }
    catch (error) { end(this.signal?.aborted ? 'interrupted' : 'failed', { error: String(error) }); throw error; }
  }
  async run<T>(kind: OperationKind, action: () => Promise<T>, evidence?: unknown): Promise<T> {
    const end = this.start(kind, evidence);
    try { const result = await action(); end(result && typeof result === 'object' && 'passed' in result && result.passed === false ? 'failed' : 'passed', result); return result; }
    catch (error) { end(this.signal?.aborted ? 'interrupted' : 'failed', { error: String(error) }); throw error; }
  }
}
