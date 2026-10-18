import type { ExecutionEntry } from '@sdlc-runner/shared';

/** A bounded live window; full history remains available through cursor API/export. */
export function mergeExecutionEntries(previous: readonly ExecutionEntry[], incoming: readonly ExecutionEntry[]): ExecutionEntry[] {
  return [...new Map([...previous, ...incoming].map(entry => [entry.id, entry])).values()].slice(-2000);
}
export function filterExecutionEntries(entries: readonly ExecutionEntry[], filter: { text: string; stage: string; item: string; attempt: string }): ExecutionEntry[] {
  return entries.filter(entry => (!filter.stage || entry.stage === filter.stage) && (!filter.item || entry.itemId === filter.item) &&
    (!filter.attempt || String(entry.attempt) === filter.attempt) && (!filter.text || JSON.stringify(entry).toLowerCase().includes(filter.text.toLowerCase())));
}
