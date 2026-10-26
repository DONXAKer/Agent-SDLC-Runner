import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runGuidedV4Scenarios } from '../src/simulator/guidedV4.ts';

test('guided v5 shares one work budget and preserves incomplete progress', async () => {
  const [result] = await runGuidedV4Scenarios('not-used-before-acceptance', ['work-budget'], 5, {
    wallClockMs: 120_000,
    requests: 1,
    outputTokens: 1_000,
    reserveWallClockMs: 0,
    reserveRequests: 0,
    reserveOutputTokens: 0,
  });
  assert.ok(result);
  assert.equal(result.actual, 'incomplete', result.errors.join('\n'));
  assert.equal(result.passed, true, result.errors.join('\n'));
  assert.ok(result.checks.includes('Every nested model call shares the same request budget'));
  assert.ok(result.checks.includes('Work budget usage is durable'));
});
