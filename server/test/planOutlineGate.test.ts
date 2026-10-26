import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '@sdlc-runner/shared';
import { AXES } from '../src/artifacts/planAxes.ts';
import { ensureCompatibilityAxisForExports, ensurePlanApproachCitations, generatePlanByCards, guidedCompactPlanResponseFormat, guidedOutlineTargetKey, materializeCompactPlan } from '../src/exec/GuidedPlanExecutor.ts';

const topology = (steps: unknown[]) => ({ steps });
const remainder = {
  approach: 'Use the inspected implementation', excluded: [], changes: 'No requirement changes', callers: [],
  axes: AXES.map(() => ({ affected: false, reason: 'No related impact', outcome: 'Preserved' })),
};
const details = { action: 'Implement the requested behavior', check: 'Exercise the behavior', expected: 'The requested result is observed', contract: 'Preserve existing consumers' };
const reply = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const, usage: emptyUsage() });

test('outline attaches uncovered required claims to the first card', async () => {
  let calls = 0;
  const raw = await generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1', 'claim-2']), async () => {
    calls++;
    if (calls === 1) return reply(topology([{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }]));
    if (calls === 2) return reply({ ...details, symbol: 'a' });
    return reply(remainder);
  }, { requiredClaims: ['claim-1', 'claim-2'], allowedTargets: ['src/a.ts'] });
  const plan = materializeCompactPlan(raw);
  assert.deepEqual(plan.steps[0]?.claims, ['claim-1', 'claim-2']);
  assert.equal(calls, 3);
});

test('empty outline still rejects uncovered required claims', async () => {
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
    return reply(topology([]));
  }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts'] }), /claim-1/);
});

test('outline rejects a full compact plan shape as topology', async () => {
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => reply({
    ...remainder,
    steps: [{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }],
  }), { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts'] }), /unrecognized key|too_big|invalid/i);
});

test('outline rejects cycles, forward references and unapproved targets before detail generation', async () => {
  for (const steps of [
    [{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [1] }],
    [{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }, { file: 'src/b.ts', claims: ['claim-1'], dependsOn: [3] }],
    [{ file: 'src/other.ts', claims: ['claim-1'], dependsOn: [] }],
  ]) {
    let calls = 0;
    await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
      calls++;
      return calls === 1 ? reply(topology(steps)) : reply({ ...details, symbol: 'a' });
    }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts', 'src/b.ts'] }));
    assert.equal(calls, 1);
  }
});

test('outline semantic gates use the structured decision validator', async () => {
  let validator: ((value: unknown) => unknown) | undefined;
  const candidate = topology([{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [1] }]);
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async (_messages, _format, validate) => {
    validator = validate;
    return reply(candidate);
  }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts'] }), /earlier card/);
  assert.equal(typeof validator, 'function');
  assert.throws(() => validator!(candidate), /earlier card/);
});

test('runtime assigns stable step IDs after a valid outline without accepting model IDs', async () => {
  let calls = 0;
  const raw = await generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
    calls++;
    if (calls === 1) return reply(topology([
      { file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] },
      { file: 'src/b.ts', claims: ['claim-1'], dependsOn: [1] },
    ]));
    if (calls === 2) return reply({ ...details, symbol: 'a' });
    if (calls === 3) return reply({ ...details, symbol: { isNew: true, name: 'verifyB' } });
    return reply(remainder);
  }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts', 'src/b.ts'] });
  const plan = materializeCompactPlan(raw);
  assert.deepEqual(plan.steps.map(step => step.id), [1, 2]);
  assert.deepEqual(plan.steps[1]?.dependsOn, [1]);
  assert.deepEqual(plan.steps.map(step => step.symbol), ['a', 'новый: verifyB']);
  assert.equal(calls, 4);
});

test('an invalid card symbol is rejected without regenerating the outline', async () => {
  let calls = 0;
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
    calls++;
    return calls === 1
      ? reply(topology([{ file: 'spec/beacon.test.ts', claims: ['claim-1'], dependsOn: [] }]))
      : reply({ ...details, symbol: { isNew: true, name: 'verifyBeacon.test' } });
  }, { requiredClaims: ['claim-1'], allowedTargets: ['spec/beacon.test.ts'] }), /Имя нового символа/);
  assert.equal(calls, 2);
});

test('outline target identity follows platform path semantics', () => {
  assert.notEqual(guidedOutlineTargetKey('src/a.ts', 'linux'), guidedOutlineTargetKey('src/A.ts', 'linux'));
  assert.notEqual(guidedOutlineTargetKey('src/a.ts', 'linux'), guidedOutlineTargetKey('src\\a.ts', 'linux'));
  assert.equal(guidedOutlineTargetKey('src/a.ts', 'win32'), guidedOutlineTargetKey('src\\A.ts', 'win32'));
});

test('duplicate file cards merge claims and remap dependencies before detail generation', async () => {
  let calls = 0;
  const raw = await generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1', 'claim-2', 'claim-3']), async () => {
    calls++;
    if (calls === 1) return reply(topology([
      { file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] },
      { file: 'src/a.ts', claims: ['claim-2'], dependsOn: [1] },
      { file: 'src/b.ts', claims: ['claim-3'], dependsOn: [2] },
    ]));
    if (calls === 2) return reply({ ...details, symbol: 'a' });
    if (calls === 3) return reply({ ...details, symbol: 'b' });
    return reply(remainder);
  }, { requiredClaims: ['claim-1', 'claim-2', 'claim-3'], allowedTargets: ['src/a.ts', 'src/b.ts'] });
  const plan = materializeCompactPlan(raw);
  assert.equal(calls, 4);
  assert.deepEqual(plan.steps.map(step => step.file), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plan.steps[0]?.claims, ['claim-1', 'claim-2']);
  assert.deepEqual(plan.steps[1]?.dependsOn, [1]);
});

test('interleaved duplicate cards remain separate when merging would create a dependency cycle', async () => {
  let calls = 0;
  const raw = await generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
    calls++;
    if (calls === 1) return reply(topology([
      { file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] },
      { file: 'src/b.ts', claims: ['claim-1'], dependsOn: [1] },
      { file: 'src/a.ts', claims: ['claim-1'], dependsOn: [2] },
    ]));
    if (calls <= 4) return reply({ ...details, symbol: calls === 2 ? 'a' : 'b' });
    return reply(remainder);
  }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts', 'src/b.ts'] });
  const plan = materializeCompactPlan(raw);
  assert.equal(calls, 5);
  assert.deepEqual(plan.steps.map(step => step.file), ['src/a.ts', 'src/b.ts', 'src/a.ts']);
  assert.deepEqual(plan.steps.map(step => step.dependsOn), [[], [1], [2]]);
});

test('a genuine dependency cycle is rejected', async () => {
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => reply(topology([
    { file: 'src/a.ts', claims: ['claim-1'], dependsOn: [2] },
    { file: 'src/b.ts', claims: ['claim-1'], dependsOn: [1] },
  ])), { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts', 'src/b.ts'] }), /dependency cycle/);
});

test('remainder without path citations gets approach evidence from fixed cards', async () => {
  let calls = 0;
  const raw = await generatePlanByCards([], guidedCompactPlanResponseFormat(['claim-1']), async () => {
    calls++;
    if (calls === 1) return reply(topology([{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }]));
    if (calls === 2) return reply({ ...details, symbol: 'runA' });
    return reply({ ...remainder, approach: 'Implement the requested validator' });
  }, { requiredClaims: ['claim-1'], allowedTargets: ['src/a.ts'] });
  assert.match((raw as { approach: string }).approach, /src\/a\.ts:runA/);
  assert.equal(ensurePlanApproachCitations('already cites src/b.ts:helper', [{ file: 'src/a.ts', symbol: 'runA' }]), 'already cites src/b.ts:helper');
  assert.equal(calls, 3);
});

test('export cards force the compatibility axis to affected=true', () => {
  const fixed = ensureCompatibilityAxisForExports({
    steps: [{ id: 2, symbol: 'validateCustomer', action: 'реэкспорт validateCustomer', claims: ['claim-4'] }],
    axes: AXES.map(name => ({ name, affected: false, reason: 'n/a', outcome: 'н/п' })),
  });
  const axis = fixed.axes.find(row => row.name === 'Совместимость и данные');
  assert.equal(axis?.affected, true);
  assert.match(axis?.outcome ?? '', /claim-4/);
});
