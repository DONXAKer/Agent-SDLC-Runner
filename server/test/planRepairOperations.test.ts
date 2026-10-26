import test from 'node:test';
import assert from 'node:assert/strict';
import { AXES } from '../src/artifacts/planAxes.ts';
import type { Plan, PlanStep } from '../src/artifacts/guidedIr.ts';
import { applyGuidedPlanRepairOperations, guidedPlanRepairOperationsResponseFormat } from '../src/exec/GuidedPlanExecutor.ts';

const step = (id: number, file: string, claims: string[] = ['claim-1'], dependsOn: number[] = []): PlanStep => ({
  id, file, isNew: false, symbol: `symbol${id}`, action: `action ${id}`, claims,
  check: `check ${id}`, expected: `expected ${id}`, contract: `contract ${id}`, dependsOn,
});

const plan = (): Plan => ({
  approach: 'Keep the implementation focused',
  steps: [step(1, 'src/first.ts'), step(2, 'src/second.ts', ['claim-1'], [1]), step(3, 'src/third.ts', ['claim-2'], [2])],
  excluded: ['Do not change unrelated modules'],
  axes: AXES.map(name => ({ name, affected: false, reason: `reason ${name}`, outcome: `outcome ${name}` })),
  changes: 'No requirement changes',
  callers: [{ symbol: 'src/first.ts:symbol1', caller: 'src/consumer.ts:4 (consume)', covered: 'нет', decision: 'Compatible' }],
});

const coverage = { requiredClaims: new Set(['claim-1', 'claim-2']), invariantClaims: new Set<string>() };

test('a narrow field repair preserves every other value', () => {
  const before = plan();
  const snapshot = structuredClone(before);
  const after = applyGuidedPlanRepairOperations(before, [{ op: 'setAction', stepId: 1, value: 'Implement only the addressed behavior' }], [1]);
  assert.deepEqual(before, snapshot);
  assert.equal(after.steps[0]?.action, 'Implement only the addressed behavior');
  assert.deepEqual({ ...after.steps[0], action: snapshot.steps[0]!.action }, snapshot.steps[0]);
  assert.deepEqual(after.steps.slice(1), snapshot.steps.slice(1));
  assert.deepEqual(after.axes, snapshot.axes);
  assert.deepEqual(after.callers, snapshot.callers);
  assert.equal(after.approach, snapshot.approach);
  assert.equal(after.changes, snapshot.changes);
  assert.deepEqual(after.excluded, snapshot.excluded);
});

test('mutations outside affected steps and axes are rejected without changing the input', () => {
  const before = plan();
  const snapshot = structuredClone(before);
  assert.throws(() => applyGuidedPlanRepairOperations(before, [{ op: 'setExpected', stepId: 2, value: 'Unsolicited' }], [1]), /не разрешена/);
  assert.throws(() => applyGuidedPlanRepairOperations(before, [{
    op: 'setAxis', name: AXES[1]!, affected: true, reason: 'Unsolicited', outcome: 'Unsolicited',
  }], [], { affectedAxes: [AXES[0]!] }), /не разрешена/);
  assert.deepEqual(before, snapshot);
});

test('add and remove deterministically renumber steps and remap dependencies to a replacement', () => {
  const replacement: Partial<PlanStep> = step(99, 'src/second.ts', ['claim-1'], [1]);
  delete replacement.id;
  const after = applyGuidedPlanRepairOperations(plan(), [
    { op: 'addStep', step: replacement },
    { op: 'removeStep', stepId: 2 },
  ], [], { coverage });
  assert.deepEqual(after.steps.map(value => value.id), [1, 2, 3]);
  assert.deepEqual(after.steps.map(value => value.file), ['src/first.ts', 'src/third.ts', 'src/second.ts']);
  assert.deepEqual(after.steps[1]?.dependsOn, [3]);
  assert.deepEqual(after.steps[2]?.dependsOn, [1]);
});

test('a repair cannot drop a required claim', () => {
  assert.throws(() => applyGuidedPlanRepairOperations(plan(), [{ op: 'removeStep', stepId: 3 }], [3], { coverage }), /claim-2/);
  assert.throws(() => applyGuidedPlanRepairOperations(plan(), [{ op: 'setClaims', stepId: 3, claims: ['claim-1'] }], [3], { coverage }), /claim-2/);
});

test('the operation repair schema contains no full-card repair or steps envelope', () => {
  const format = guidedPlanRepairOperationsResponseFormat(['claim-1'], [1, 2], undefined, [], 'steps') as any;
  const schema = format.json_schema.schema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['operations', 'version']);
  assert.equal(schema.properties.steps, undefined);
  const serialized = JSON.stringify(schema.properties.operations);
  assert.match(serialized, /setAction/);
  assert.doesNotMatch(serialized, /removeSteps/);
});
