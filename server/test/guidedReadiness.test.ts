import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreparedPrompt } from '@sdlc-runner/shared';
import { guidedRuntimeReadiness } from '../src/run/guidedReadiness.ts';

test('runtime readiness permits work with open business questions without claiming they are answered', () => {
  const result = guidedRuntimeReadiness('intent', { guidedProtocol: true, user: JSON.stringify({ data: {
    requests: ['Add payment terms; the number of days must be clarified.'],
  } }) } as PreparedPrompt);
  assert.equal(result.checkedBy, 'runtime'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.evidence, []);
  // Dates and revision hashes may contain arbitrary digits. Only business-facing
  // statements can invent a numeric answer to the unresolved requirement.
  assert.doesNotMatch([result.decision, result.reason, ...result.evidence, ...result.uncertainties].join('\n'), /\b\d+\b/u);
  assert.equal(result.changed, false);
});
test('runtime readiness blocks corrupt or absent original requirements', () => {
  for (const user of ['broken', '{"data":{"requests":[]}}', '{"data":{"requests":[null]}}']) {
    assert.equal(guidedRuntimeReadiness('intent', { guidedProtocol: true, user } as PreparedPrompt).status, 'blocked');
  }
});
