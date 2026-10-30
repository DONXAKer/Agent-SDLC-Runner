import test from 'node:test';
import assert from 'node:assert/strict';
import { guidedFunnel, renderGuidedFunnel } from '../src/guidedFunnel.ts';

const reached = ['intent', 'explore', 'ask', 'plan'].map(stage => ({ stage, ok: true, skipped: stage === 'ask' }));

test('воронка считает только завершённые ячейки и фактические доказательства переходов', () => {
  const funnel = guidedFunnel([
    { status: 'complete', outcome: { success: true, reached, firstMutation: { stage: 'chunk' } }, evidence: { verifyReached: true } },
    { status: 'complete', outcome: { success: false, reached: reached.slice(0, 3) }, evidence: { verifyReached: false } },
    { status: 'running', outcome: { success: false, reached, firstMutation: {} }, evidence: { verifyReached: true } },
  ]);
  assert.deepEqual(funnel, { started: 2, intent: 2, ask: 2, plan: 1, firstMutation: 1, verify: 1, acceptance: 1 });
  assert.match(renderGuidedFunnel(funnel), /Запущен Verify \| 1/);
});

test('отсутствие reached или evidence не угадывается по успеху соседней стадии', () => {
  assert.deepEqual(guidedFunnel([{ status: 'complete', outcome: { success: false } }]), {
    started: 1, intent: 0, ask: 0, plan: 0, firstMutation: 0, verify: 0, acceptance: 0,
  });
});
