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
  assert.equal(assessed.environmentFailure, true);
  assert.equal(assessGuidedValidation(null, identity, 2, { ...preflight, startedAt: '2025-01-01T00:00:00Z' }).status, 'no-current-result');
});

test('live outcome separates model quality from operational and environment results', () => {
  const success = assessGuidedValidation(result, identity, 0);
  assert.equal(success.outcomeKind, 'full-flow-success');
  assert.equal(success.evidenceLevel, 'live-full-flow');
  assert.equal(success.modelQualitySuccess, true);
  assert.equal(success.operationalSuccess, true);

  const environment = assessGuidedValidation({ ...result, driver: { ...result.driver,
    stages: [{ stage: 'intent', ok: true, modelRequests: 2, envFailure: 'provider timeout' }] } }, identity, 2);
  assert.equal(environment.success, false);
  assert.equal(environment.outcomeKind, 'environment-failure');
  assert.equal(environment.modelTaskEvaluated, false);
  assert.equal(environment.environmentFailure, true);
  assert.equal(environment.operationalSuccess, false);

  const failed = assessGuidedValidation({ ...result, hidden: { ...result.hidden, pass: 1, fail: 1 } }, identity, 1);
  assert.equal(failed.outcomeKind, 'model-task-failure');
  assert.equal(failed.modelTaskEvaluated, true);
  assert.equal(failed.environmentFailure, false);
  assert.equal(failed.evidenceLevel, 'live-partial');

  const exitTwo = assessGuidedValidation(result, identity, 2);
  assert.equal(exitTwo.outcomeKind, 'environment-failure');
  assert.equal(exitTwo.modelTaskEvaluated, false);
  for (const stopped of ['stage-timeout', 'run-timeout']) {
    const timeout = assessGuidedValidation({ ...result, driver: { ...result.driver, stopped } }, identity, 1);
    assert.equal(timeout.outcomeKind, 'environment-failure');
    assert.equal(timeout.modelTaskEvaluated, false);
  }
  const incomplete = assessGuidedValidation(result, identity, null);
  assert.equal(incomplete.status, 'no-current-result');
  assert.equal(incomplete.outcomeKind, 'incomplete');
  assert.equal(incomplete.modelTaskEvaluated, false);
  assert.equal(incomplete.environmentFailure, false);
});
