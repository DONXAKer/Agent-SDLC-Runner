import { test } from 'node:test';
import { equal, throws, deepStrictEqual } from 'node:assert/strict';
import { simulatorDecisionQuestion } from '../src/simulator/decisionPacket.ts';
import { isUnknownIntentStop } from '../src/simulator/intentStop.ts';
import type { DriverStageRecord } from '../src/driver.ts';

test('unknown semantics require the exact Intent stop and reject unrelated failures', () => {
  const stage: DriverStageRecord = { stage: 'intent', chunk: 1, attempt: 1, ok: false, note: 'unresolved evidence', blockers: [],
    timedOut: false, skipped: false, diagnostic: { category: 'human-required' } };
  equal(isUnknownIntentStop({ stopped: 'blocked', stages: [stage] }), true);
  equal(isUnknownIntentStop({ stopped: 'stage-timeout', stages: [stage] }), false);
  for (const changed of [{ ...stage, stage: 'plan' as const }, { ...stage, timedOut: true }, { ...stage, skipped: true },
    { ...stage, envFailure: 'network' }, { ...stage, diagnostic: { category: 'runtime' as const } }])
    equal(isUnknownIntentStop({ stopped: 'blocked', stages: [changed] }), false);
  equal(isUnknownIntentStop({ stopped: 'blocked', stages: [stage, { ...stage, stage: 'plan' }] }), false);
});

test('simulator unwraps current decision packets without requiring a journal ID', () => {
  const first = { source: { path: 'lib/record.ts' } }, second = { question: 'card' };
  const packet = { version: 1, context: { revision: 'one' }, question: [first, second] };
  deepStrictEqual(simulatorDecisionQuestion(packet), first);
  deepStrictEqual(simulatorDecisionQuestion(packet, true), second);
  deepStrictEqual(simulatorDecisionQuestion({ ...packet, responseSchema: { type: 'object' } }), first);
  throws(() => simulatorDecisionQuestion(first), /Incomplete/);
});
