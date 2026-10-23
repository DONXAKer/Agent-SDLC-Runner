import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuidedV4Scenarios } from '../src/simulator/guidedV4.ts';

test('guided v4 full-flow covers current preparation, repair, bad code and restart', { timeout: 240000, skip: !process.env.SDLC_TEST_DOCKER_IMAGE }, async () => {
  const results = await runGuidedV4Scenarios(process.env.SDLC_TEST_DOCKER_IMAGE!);
  assert.equal(results.length, 6);
  for (const result of results) assert.equal(result.passed, true, `${result.id}: ${result.errors.join('; ')}`);
  const happy = results[0]!;
  const stages = happy.trace.filter((e: unknown) => (e as { type?: string }).type === 'stage_done') as { stage: string }[];
  assert.deepEqual(stages.map(e => e.stage), ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff']);
});
