import type { StageId } from '@sdlc-runner/shared';
import type { ChatTurn } from '../provider/ChatProvider.ts';
import { GuidedProgress, progressHash } from '../run/guidedProgress.ts';
import { parseGuidedDecisionJson } from './guidedJson.ts';
import { narrowGuidedRepair } from './guidedRecovery.ts';
import { z } from 'zod';

/** One durable proposal boundary, including secondary review/repair calls.
 * Provider failures propagate; only rejected model content spends repair attempts.
 * The caller still owns applying the result and observing the actual outcome. */
export async function guidedProposal(o: {
  store: GuidedProgress; id: string; stage: StageId; signal: AbortSignal;
  dependencies: () => Record<string, string>; format: Record<string, unknown>;
  validate: (text: string) => unknown;
  ask: (feedback: string, format: Record<string, unknown>, fields: readonly string[]) => Promise<ChatTurn>;
}): Promise<string> {
  const ticket = o.store.begin(o.id, o.stage, o.dependencies());
  const recovery = o.store.read().recoveries[o.id];
  if (recovery?.stopped && recovery.inputHash === progressHash(ticket.dependencies))
    throw new Error(`Восстановление ${o.id} остановлено: ${recovery.reason}`);
  const reused = o.store.reuse(ticket, raw => {
    const text = JSON.stringify(raw); o.validate(text); return text;
  });
  if (reused !== null) return reused;
  let feedback = recovery?.inputHash === progressHash(ticket.dependencies) ? recovery.reason : '';
  let narrow = recovery?.inputHash === progressHash(ticket.dependencies) && recovery.repair
    ? narrowGuidedRepair(recovery.repair.raw, new z.ZodError(recovery.repair.fields.map(field => ({ code: 'custom', path: [field], message: recovery.reason }))), o.format)
    : null;
  for (;;) {
    o.signal.throwIfAborted();
    const answer = await o.ask(feedback, narrow?.format ?? o.format, narrow?.fields ?? []);
    o.signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = parseGuidedDecisionJson(answer.text, answer.toolCalls, answer.finishReason === 'max_tokens');
      if (narrow) raw = narrow.merge(raw);
      o.validate(JSON.stringify(raw));
    } catch (error) {
      feedback = (error as Error).message.slice(0, 2000);
      const action = o.store.reject(ticket, 'proposal', feedback);
      if (action === 'stop') throw new Error(`Предложение ${o.id} не исправлено: ${feedback}`);
      if (action === 'narrow') {
        narrow = narrowGuidedRepair(raw, error, o.format);
        if (!narrow) {
          o.store.stop(ticket, 'proposal', `Нет безопасного адресованного ремонта: ${feedback}`);
          throw new Error(`Нет адресованного ремонта ${o.id}: ${feedback}`);
        }
        o.store.rememberRepair(ticket, raw, narrow.fields);
      }
      continue;
    }
    o.store.accept(ticket, raw, o.dependencies());
    return JSON.stringify(raw);
  }
}
