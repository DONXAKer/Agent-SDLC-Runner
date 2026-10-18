import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDuplicatePlanSteps } from '../src/exec/GuidedPlanExecutor.ts';
import { AXES } from '../src/artifacts/planAxes.ts';

const baseStep = (id: number, file: string, symbol: string, action: string, claims: string[], dependsOn: number[] = []) => ({
  id, file, isNew: false, symbol, action, claims, check: 'test', expected: 'pass', contract: 'same', dependsOn,
});

const basePlan = (steps: ReturnType<typeof baseStep>[]) => ({
  approach: 'merge test', steps, excluded: [], axes: AXES.map(name => ({ name, affected: false, reason: 'r', outcome: 'o' })),
  changes: 'none', callers: [] as { symbol: string; caller: string; covered: 'да' | 'нет'; decision: string }[],
});

test('mergeDuplicatePlanSteps joins cards for the same file into one survivor', () => {
  const plan = basePlan([
    baseStep(1, 'src/a.ts', 'foo', 'implement foo', ['claim-1']),
    baseStep(2, 'src/a.ts', 'bar', 'test foo', ['claim-2'], [1]),
    baseStep(3, 'src/b.ts', 'baz', 'implement baz', ['claim-3']),
  ]);
  const merged = mergeDuplicatePlanSteps(plan);
  assert.equal(merged.steps.length, 2);
  const a = merged.steps.find(s => s.file === 'src/a.ts');
  assert.ok(a);
  assert.equal(a.symbol, 'foo');
  assert.equal(a.action, 'implement foo; test foo');
  assert.deepEqual(a.claims, ['claim-1', 'claim-2']);
  // Зависимость на удалённый дубль должна исчезнуть.
  assert.deepEqual(a.dependsOn, []);
  const b = merged.steps.find(s => s.file === 'src/b.ts');
  assert.ok(b);
  assert.equal(b.id, 2, 'нумерация пересчитывается после слияния');
});

test('mergeDuplicatePlanSteps keeps a single new symbol and mentions the rest in action', () => {
  const plan = basePlan([
    { ...baseStep(1, 'src/a.ts', 'новый: foo', 'add foo', ['claim-1']), isNew: true },
    { ...baseStep(2, 'src/a.ts', 'новый: bar', 'add bar', ['claim-2']), isNew: true },
  ]);
  const merged = mergeDuplicatePlanSteps(plan);
  assert.equal(merged.steps.length, 1);
  assert.equal(merged.steps[0]?.symbol, 'новый: foo');
  assert.ok(merged.steps[0]?.action.includes('bar'));
  assert.deepEqual(merged.steps[0]?.claims, ['claim-1', 'claim-2']);
});

test('mergeDuplicatePlanSteps does not alter a plan with unique files', () => {
  const plan = basePlan([
    baseStep(1, 'src/a.ts', 'foo', 'change foo', ['claim-1']),
    baseStep(2, 'src/b.ts', 'bar', 'change bar', ['claim-2'], [1]),
  ]);
  const merged = mergeDuplicatePlanSteps(plan);
  assert.equal(merged.steps.length, 2);
  assert.equal(merged.steps[0]?.id, 1);
  assert.equal(merged.steps[1]?.id, 2);
  assert.deepEqual(merged.steps[1]?.dependsOn, [1]);
});

test('mergeDuplicatePlanSteps deduplicates semicolon-joined fields', () => {
  const plan = basePlan([
    baseStep(1, 'src/a.ts', 'foo', 'same action', ['claim-1']),
    baseStep(2, 'src/a.ts', 'foo', 'same action', ['claim-1']),
  ]);
  const merged = mergeDuplicatePlanSteps(plan);
  assert.equal(merged.steps[0]?.action, 'same action');
  assert.deepEqual(merged.steps[0]?.claims, ['claim-1']);
});
