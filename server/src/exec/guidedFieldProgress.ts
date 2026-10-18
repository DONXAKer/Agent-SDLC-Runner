import { emptyUsage, type StageId } from '@sdlc-runner/shared';
import { GuidedProgress, progressHash, type ProgressTicket } from '../run/guidedProgress.ts';
import type { ChatTurn } from '../provider/ChatProvider.ts';
import { parseGuidedJson } from './guidedJson.ts';

/** Keeps structured values until the form renderer and content checks accept them.
 * A cached proposal still traverses those checks and the ordinary write gate. */
export class GuidedFieldProgress {
  private readonly store: GuidedProgress;
  private readonly stage: StageId;
  private readonly sources: () => Record<string, string>;
  private readonly pending = new Map<string, { ticket: ProgressTicket; value?: unknown; rejected?: boolean }>();
  constructor(store: GuidedProgress, stage: StageId, sources: () => Record<string, string>) {
    this.store = store; this.stage = stage; this.sources = sources;
  }
  begin(id: string, packet: unknown): ChatTurn | null {
    const ticket = this.store.begin(`${this.stage}:field:${id}`, this.stage, { ...this.sources(), packet: progressHash(packet) });
    this.pending.set(id, { ticket });
    const recovery = this.store.read().recoveries[ticket.id];
    if (recovery?.stopped && recovery.inputHash === progressHash(ticket.dependencies)) throw new Error(`Повторы ${id} исчерпаны: ${recovery.reason}`);
    const value = this.store.reuse(ticket, raw => {
      if (raw === undefined) throw new Error('Отсутствует значение поля');
      return raw;
    });
    if (value === null) return null;
    this.pending.set(id, { ticket, value });
    return { text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  }
  proposed(id: string, turn: ChatTurn): void {
    const pending = this.pending.get(id);
    if (!pending || turn.toolCalls.length || turn.finishReason === 'max_tokens') return;
    try { pending.value = parseGuidedJson(turn.text); } catch { /* executor records precise rejection */ }
  }
  accept(id: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.value === undefined) return;
    this.store.accept(pending.ticket, pending.value, { ...this.sources(), packet: pending.ticket.dependencies.packet! });
    this.pending.delete(id);
  }
  reject(id: string, reason: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.rejected) return;
    pending.rejected = true;
    const action = this.store.reject(pending.ticket, 'field', reason);
    // Addressed field prompts already isolate this unit; the third error must
    // additionally receive the exact field/schema diagnostic from the caller.
    if (action === 'stop') throw new Error(`Поле ${id} не исправлено после ограниченного восстановления: ${reason}`);
  }
}
