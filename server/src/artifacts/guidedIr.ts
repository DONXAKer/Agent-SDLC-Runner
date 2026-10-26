import { z } from 'zod';

const text = z.string().trim().min(1);
const claimId = z.string().regex(/^claim-\d+$/u);
export const SourceLineRange = z.tuple([z.number().int().positive(), z.number().int().positive()]);
export const SourceReference = z.object({ source: text, lines: SourceLineRange, excerpt: z.string().optional() }).strict();

export const AcceptanceClaim = z.object({
  id: claimId,
  behavior: text,
  procedure: text,
  expected: text,
}).strict();
export const BasisClaim = z.object({
  id: claimId,
  basis: SourceReference,
  scenario: text,
  counterexample: text,
}).strict();
export const IntentIr = z.object({
  version: z.literal(1),
  acceptance: z.array(AcceptanceClaim).min(1).max(24),
  basis: z.array(BasisClaim).max(24),
}).strict();

export const QuestionResolutionIr = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), evidenceId: text, answer: text }).strict(),
  z.object({ kind: z.literal('engineering'), evidenceId: text,
    category: z.enum(['comment', 'test_name', 'check_method', 'implementation_detail']), choice: text, reason: text }).strict(),
  z.object({ kind: z.literal('context'), path: text, reason: text, lines: SourceLineRange.nullable().optional() }).strict(),
  z.object({ kind: z.literal('human'), missingDecision: text, options: z.array(text).length(2), consequence: text, reason: text }).strict(),
]);
export const QuestionEntryIr = z.object({
  id: text,
  question: text,
  origin: z.array(text),
  requestHash: z.string(),
  status: z.enum(['source', 'engineering', 'context', 'human', 'protocol', 'answered', 'deferred']),
  answer: z.string(),
  reason: z.string(),
  options: z.array(z.string()),
  sourceHashes: z.record(z.string(), z.string()),
  citations: z.array(z.object({ source: z.string(), quote: z.string() }).strict()),
  evidence: z.array(SourceReference).optional(),
}).strict();
export const QuestionsIr = z.object({ version: z.literal(1), entries: z.array(QuestionEntryIr) }).strict();

export const PlanStep = z.object({
  id: z.number().int().positive(),
  file: text,
  isNew: z.boolean(),
  symbol: text,
  action: text,
  claims: z.array(text),
  check: text,
  expected: text,
  contract: text,
  dependsOn: z.array(z.number().int().positive()),
}).strict();
export const PlanAxis = z.object({ name: text, affected: z.boolean(), reason: text, outcome: text }).strict();
export const PlanCaller = z.object({ symbol: text, caller: text, covered: z.enum(['да', 'нет']), decision: text }).strict();
export const Plan = z.object({
  approach: text,
  steps: z.array(PlanStep).max(24),
  excluded: z.array(text),
  axes: z.array(PlanAxis),
  changes: text,
  callers: z.array(PlanCaller).max(120).default([]),
}).strict();
export const PlanIr = z.object({ version: z.literal(1), plan: Plan }).strict();

export const PlanRepairOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setTarget'), stepId: z.number().int().positive(), file: text, symbol: text }).strict(),
  z.object({ op: z.literal('setAction'), stepId: z.number().int().positive(), value: text }).strict(),
  z.object({ op: z.literal('setCheck'), stepId: z.number().int().positive(), check: text, expected: text }).strict(),
  z.object({ op: z.literal('setExpected'), stepId: z.number().int().positive(), value: text }).strict(),
  z.object({ op: z.literal('setContract'), stepId: z.number().int().positive(), value: text }).strict(),
  z.object({ op: z.literal('setClaims'), stepId: z.number().int().positive(), claims: z.array(claimId).min(1) }).strict(),
  z.object({ op: z.literal('addStep'), step: PlanStep.omit({ id: true }) }).strict(),
  z.object({ op: z.literal('removeStep'), stepId: z.number().int().positive() }).strict(),
  z.object({ op: z.literal('setAxis'), name: text, affected: z.boolean(), reason: text, outcome: text }).strict(),
  z.object({ op: z.literal('setCallerDecision'), caller: text, decision: text }).strict(),
  z.object({ op: z.literal('setApproach'), value: text }).strict(),
  z.object({ op: z.literal('setExcluded'), value: z.array(text) }).strict(),
  z.object({ op: z.literal('setChanges'), value: text }).strict(),
]);
export const PlanRepairIr = z.object({ version: z.literal(1), operations: z.array(PlanRepairOperation).min(1).max(24) }).strict();
export const PreparationIr = z.object({
  version: z.literal(1),
  intent: IntentIr.optional(),
  questions: QuestionsIr.optional(),
  plan: PlanIr.optional(),
}).strict();

export type SourceReference = z.infer<typeof SourceReference>;
export type IntentIr = z.infer<typeof IntentIr>;
export type QuestionResolutionIr = z.infer<typeof QuestionResolutionIr>;
export type QuestionEntryIr = z.infer<typeof QuestionEntryIr>;
export type QuestionsIr = z.infer<typeof QuestionsIr>;
export type PlanStep = z.infer<typeof PlanStep>;
export type Plan = z.infer<typeof Plan>;
export type PlanIr = z.infer<typeof PlanIr>;
export type PlanRepairOperation = z.infer<typeof PlanRepairOperation>;
