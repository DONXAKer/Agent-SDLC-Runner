/** Decode the public packet contract; journal-only IDs are never model input. */
export function simulatorDecisionQuestion(value: unknown, last = false): unknown {
  if (!value || typeof value !== 'object') throw new Error('Expected a decision packet');
  const packet = value as Record<string, unknown>;
  if (packet.version !== 1 || !packet.context || !Array.isArray(packet.question) || !packet.question.length)
    throw new Error('Incomplete stateless decision packet');
  return last ? packet.question.at(-1) : packet.question[0];
}
