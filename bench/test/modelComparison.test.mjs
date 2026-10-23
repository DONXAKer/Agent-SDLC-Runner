import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionCases, requestFor, probabilityOf, metrics, choiceRequest, choiceOf } from '../model-comparison/cases.mjs';

test('comparison holdout is disjoint and labels never enter model requests', () => {
  assert.equal(decisionCases.length, 60);
  assert.equal(new Set(decisionCases.map(c => c.id)).size, 60);
  for (const split of ['diagnostic', 'holdout']) {
    assert.equal(decisionCases.filter(c => c.split === split).length, 30);
    for (const family of new Set(decisionCases.map(c => c.family)))
      assert.equal(decisionCases.filter(c => c.split === split && c.family === family).length, 5);
  }
  for (const c of decisionCases) {
    const req = requestFor(c);
    assert.deepEqual(Object.keys(req).sort(), ['questions', 'state']);
    assert.equal(JSON.stringify(req).includes('expected'), false);
  }
});
test('order control changes only candidate order and requires an explicit choice', () => {
  const c = decisionCases[0], a = choiceRequest(c), b = choiceRequest(c, true);
  assert.deepEqual(Object.keys(a.questions.decision.criteria), ['yes', 'no']);
  assert.deepEqual(Object.keys(b.questions.decision.criteria), ['no', 'yes']);
  assert.equal(a.state, b.state);
  assert.equal(a.questions.decision.instructions, b.questions.decision.instructions);
  assert.throws(() => choiceOf({ answers: { decision: { confidence: 0.99 } } }));
  assert.equal(choiceOf({ answers: { decision: { choice: 'no' } } }), 'no');
});
test('invalid probabilities cannot become permission or success', () => {
  for (const value of [undefined, null, '0.9', NaN, Infinity, -0.1, 1.1])
    assert.throws(() => probabilityOf({ answers: { decision: { noul: value } } }));
  assert.equal(probabilityOf({ answers: { decision: { noul: 0.25 } } }), 0.25);
  const result = metrics([{ family: 'scope', expected: false, probability: 0.9 },
    { family: 'unknown', expected: false, probability: 0.8 }, { family: 'scope', expected: true, error: 'timeout' }]);
  assert.equal(result.valid, 2);
  assert.equal(result.falseAllow, 1);
  assert.equal(result.unsupported, 1);
  assert.equal(result.correct, 0);
});
