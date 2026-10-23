import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentGuidedResult, assessGuidedValidation } from '../src/guidedValidation.ts';

const identity = { slug: 'unique-invocation', task: 'arbitrary-task', model: 'local:example', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z' };
const result = { run: { ...identity, startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:04:00Z', executionMode: 'guided', guidedEngineVersion: 4, preparationVersion: 3, strictQuestions: true },
  driver: { stopped: 'handoff', stages: [{ stage: 'intent', ok: true, modelRequests: 2 }] }, finalVerdict: { passed: true, reasons: [] },
  hidden: { total: 2, pass: 2, fail: 0, skipped: 0, errorText: null }, honesty: [{ ok: true }] };

test('validation accepts only the same invocation and exact protocol', () => {
  assert.equal(currentGuidedResult(result, identity), true);
  for (const patch of [{ slug: 'previous' }, { model: 'other' }, { task: 'other' }, { guidedEngineVersion: 3 },
    { preparationVersion: 1 }, { strictQuestions: false }, { startedAt: '2025-12-31T23:59:59Z' },
    { finishedAt: 'invalid' }, { finishedAt: '2026-01-01T00:06:00Z' }, { finishedAt: '2026-01-01T00:00:00Z' }])
    assert.equal(currentGuidedResult({ ...result, run: { ...result.run, ...patch } }, identity), false, JSON.stringify(patch));
});

test('a failed launcher and a stale positive result never count as a success', () => {
  assert.equal(assessGuidedValidation(result, identity, 0).success, true);
  assert.equal(assessGuidedValidation(result, identity, 2).success, false);
  assert.equal(assessGuidedValidation({ ...result, run: { ...result.run, startedAt: '2025-01-01T00:00:00Z' } }, identity, 2).status, 'no-current-result');
  assert.equal(assessGuidedValidation(null, identity, 2).status, 'no-current-result');
  assert.equal(assessGuidedValidation({ ...result, hidden: null }, identity, 0).success, false);
});

test('current red preflight is reported independently and overrides a stale positive result', () => {
  const preflight = { ...identity, model: identity.model, task: identity.task, passed: false, envBlocked: true,
    startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:03Z',
    checks: [{ name: 'engine', ok: false, env: true, detail: 'not available', durationMs: 2 }] };
  const assessed = assessGuidedValidation(result, identity, 2, preflight);
  assert.equal(assessed.status, 'preflight-failed');
  assert.equal(assessed.success, false);
  assert.equal(assessGuidedValidation(null, identity, 2, { ...preflight, startedAt: '2025-01-01T00:00:00Z' }).status, 'no-current-result');
});
