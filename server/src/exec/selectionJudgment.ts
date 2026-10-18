import { z } from 'zod';
import { parseGuidedJson } from './guidedJson.ts';

const Judgment = z.object({ selected: z.string().nullable(),
  outcome: z.enum(['select', 'reject_all', 'insufficient_evidence']),
  reason: z.string().trim().min(1).max(1200) }).strict();

export function parseSelectionJudgment(text: string, ids: readonly string[]) {
  const value = Judgment.parse(parseGuidedJson(text));
  if (value.outcome === 'select' ? value.selected === null || !ids.includes(value.selected) : value.selected !== null)
    throw new Error('Оценщик выбрал неизвестный кандидат или противоречивый исход');
  return value;
}
