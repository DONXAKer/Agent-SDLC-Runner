import test from 'node:test';
import assert from 'node:assert/strict';
import { throughputFromQualification, wallclockScale } from '../src/modelPassport.ts';
import type { Qualification } from '../src/modelQualification.ts';

function probe(completion: number, prompt: number, reasoning = ''): Qualification['cases'][number] {
  return { name: 'p', repetition: 1, passed: true, transportOk: true,
    response: { usage: { completion_tokens: completion, prompt_tokens: prompt }, choices: [{ message: { content: '{}', reasoning } }] } };
}

test('паспорт считается из usage квалификационных проб', () => {
  const passport = throughputFromQualification({ passed: true, elapsedMs: 60_000, cases: [
    probe(100, 200, 'x'.repeat(400)), probe(300, 200), { name: 'broken', repetition: 1, passed: false, error: 'HTTP 500' },
  ] });
  assert.ok(passport);
  assert.equal(passport.decisions, 2);
  assert.equal(passport.completionTokens, 400);
  assert.equal(passport.secondsPerDecision, 30);
  assert.equal(passport.tokensPerSecond, 6.67);
  assert.equal(passport.reasoningShare, 0.25);
});

test('без usage паспорта нет', () => {
  assert.equal(throughputFromQualification({ passed: false, elapsedMs: 1000, cases: [{ name: 'p', repetition: 1, passed: false, error: 'x' }] }), null);
});

test('коэффициент стенных часов: 1 без паспорта или политики, не меньше 1, не больше потолка', () => {
  const slow = throughputFromQualification({ passed: true, elapsedMs: 12_000, cases: [probe(10, 10)] })!; // 12 с/решение
  const fast = throughputFromQualification({ passed: true, elapsedMs: 1_000, cases: [probe(10, 10)] })!; // 1 с/решение
  assert.equal(wallclockScale(null, { referenceDecisionSeconds: 3, maxScale: 3 }), 1);
  assert.equal(wallclockScale(slow, undefined), 1);
  assert.equal(wallclockScale(fast, { referenceDecisionSeconds: 3, maxScale: 3 }), 1);
  assert.equal(wallclockScale(slow, { referenceDecisionSeconds: 3, maxScale: 3 }), 3);
  assert.equal(wallclockScale(slow, { referenceDecisionSeconds: 8, maxScale: 3 }), 1.5);
});
