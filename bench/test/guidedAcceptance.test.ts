import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedAcceptance } from '../src/guidedAcceptance.ts';
import type { BenchResult } from '../src/result.ts';

test('acceptance requires final verdict, hidden checks, honest evidence and active budget', () => {
  const result = { run: { executionMode: 'guided', preparationVersion: 3, strictQuestions: true },
    driver: { stopped: 'handoff' }, finalVerdict: { passed: true }, guided: { activeMs: 100 },
    metrics: { stages: [{ durationMs: 900 }], human: [{ waitMs: 200 }] },
    hidden: { total: 2, pass: 2, fail: 0, skipped: 0, errorText: null }, honesty: [{ ok: true }],
  } as unknown as BenchResult;
  assert.equal(guidedAcceptance(result, 'guided').success, true);
  assert.equal(guidedAcceptance(null, 'guided').success, false);
  assert.equal(guidedAcceptance({ ...result, hidden: null }, 'guided').success, false);
  assert.equal(guidedAcceptance({ ...result, hidden: { ...result.hidden!, skipped: 1 } }, 'guided').success, false);
  assert.equal(guidedAcceptance({ ...result, guided: { ...result.guided!, activeMs: 1800001 } }, 'guided').success, false);
  assert.equal(guidedAcceptance({ ...result, honesty: [{ method: 'hiddenTests', ok: false, detail: 'failure' }] }, 'guided').success, false);
  assert.equal(guidedAcceptance({ ...result, run: { ...result.run, executionMode: 'legacy' } }, 'legacy').activeMs, 700);
});
