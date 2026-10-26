import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '@sdlc-runner/shared';
import { AXES } from '../src/artifacts/planAxes.ts';
import { generatePlanByCards, guidedCompactPlanResponseFormat } from '../src/exec/GuidedPlanExecutor.ts';

test('card generation binds target identities and fills only one card per response', async () => {
  const outline = { steps: [{ file: 'lib/beacon.ts', claims: ['check-1'], dependsOn: [] }, { file: 'spec/beacon.test.ts', claims: ['check-1'], dependsOn: [1] }] };
  const remainder = {
    approach: 'Preserve the existing API while extending behavior', excluded: [], changes: 'No public compatibility change', callers: [],
    axes: AXES.map(() => ({ affected: false, reason: 'No corresponding change', outcome: 'Preserved' })),
  };
  const symbols: unknown[] = ['Beacon', { isNew: true, name: 'verifyBeacon' }];
  const details = { action: 'Implement the requested behavior', check: 'Run the behavior test', expected: 'The requested result is observed', contract: 'Preserve existing callers' };
  let calls = 0;
  const result = await generatePlanByCards([{ role: 'user', content: 'Request and observed sources' }], guidedCompactPlanResponseFormat(['check-1'], ['Beacon']), async (messages, format) => {
    calls++;
    const name = (format as { json_schema?: { name?: string } }).json_schema?.name;
    if (name === 'guided_plan_outline') {
      assert.deepEqual(Object.keys((format as any).json_schema.schema.properties), ['steps']);
      return { text: JSON.stringify(outline), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
    }
    if (name === 'guided_plan_card') {
      const input = JSON.parse(messages.at(-1)!.content);
      assert.equal(input.card, calls - 1);
      assert.deepEqual(input.target, outline.steps[calls - 2]);
      assert.deepEqual(Object.keys((format as any).json_schema.schema.properties).sort(), ['action', 'check', 'contract', 'expected', 'symbol']);
      return { text: JSON.stringify({ ...details, symbol: symbols[calls - 2] }), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
    }
    assert.equal(name, 'guided_plan_remainder');
    assert.deepEqual(Object.keys((format as any).json_schema.schema.properties).sort(),
      ['approach', 'axes', 'callers', 'changes', 'excluded']);
    return { text: JSON.stringify(remainder), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  });
  assert.equal(calls, 4);
  assert.deepEqual((result as any).steps.map((step: any) => step.file), ['lib/beacon.ts', 'spec/beacon.test.ts']);
  assert.deepEqual((result as any).steps.map((step: any) => step.symbol), ['Beacon', 'новый: verifyBeacon']);
  assert.deepEqual((result as any).steps[1].dependsOn, [1]);
  assert.equal((result as any).approach, remainder.approach);
});

test('a truncated outline cannot become an accepted partial plan', async () => {
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(), async () => ({ text: '{}', toolCalls: [], finishReason: 'max_tokens', usage: emptyUsage() })), /token-limit/);
});
