import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '@sdlc-runner/shared';
import { AXES } from '../src/artifacts/planAxes.ts';
import { generatePlanByCards, guidedCompactPlanResponseFormat } from '../src/exec/GuidedPlanExecutor.ts';

test('card generation binds target identities and fills only one card per response', async () => {
  const outline = { approach: 'Preserve the existing API while extending behavior', excluded: [], changes: 'No public compatibility change', callers: [],
    axes: AXES.map(() => ({ affected: false, reason: 'No corresponding change', outcome: 'Preserved' })),
    steps: [{ file: 'lib/beacon.ts', symbol: 'Beacon', claims: ['check-1'], dependsOn: [] }, { file: 'spec/beacon.test.ts', symbol: { isNew: true, name: 'verifyBeacon' }, claims: ['check-1'], dependsOn: [1] }] };
  const details = { action: 'Implement the requested behavior', check: 'Run the behavior test', expected: 'The requested result is observed', contract: 'Preserve existing callers' };
  let calls = 0;
  const result = await generatePlanByCards([{ role: 'user', content: 'Request and observed sources' }], guidedCompactPlanResponseFormat(['check-1'], ['Beacon']), async (messages, format) => {
    if (calls > 0) {
      const input = JSON.parse(messages.at(-1)!.content);
      assert.equal(input.card, calls);
      const expected = outline.steps[calls - 1]!;
      assert.deepEqual(input.target, { ...expected, symbol: typeof expected.symbol === 'string' ? expected.symbol : `новый: ${expected.symbol.name}` });
      assert.deepEqual(Object.keys((format as any).json_schema.schema.properties).sort(), ['action', 'check', 'contract', 'expected']);
    }
    return { text: JSON.stringify(calls++ === 0 ? outline : details), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  });
  assert.equal(calls, 3);
  assert.deepEqual((result as any).steps.map((step: any) => step.file), ['lib/beacon.ts', 'spec/beacon.test.ts']);
  assert.deepEqual((result as any).steps[1].dependsOn, [1]);
});

test('a truncated outline cannot become an accepted partial plan', async () => {
  await assert.rejects(generatePlanByCards([], guidedCompactPlanResponseFormat(), async () => ({ text: '{}', toolCalls: [], finishReason: 'max_tokens', usage: emptyUsage() })), /token-limit/);
});
