import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStateFirstScenarios } from '../src/simulator/stateFirst.ts';

test('state-first: main Run enforces independent acceptance and canonical state', { skip: !process.env.SDLC_TEST_DOCKER_IMAGE }, async () => {
  const cases = await runStateFirstScenarios(process.env.SDLC_TEST_DOCKER_IMAGE!);
  assert.equal(cases.length, 7);
  assert.ok(cases.every(c => c.checks.length && c.passed && c.errors.length === 0), JSON.stringify(cases.map(({ trace, ...c }) => c), null, 2));
});
