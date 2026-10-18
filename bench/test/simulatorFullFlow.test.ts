import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFullFlowScenarios } from '../src/simulator/fullFlow.ts';

test('full-flow: настоящий Run принимает контроль, блокирует ложный успех и восстанавливается', { timeout: 180000 }, async () => {
  const results = await runFullFlowScenarios();
  assert.equal(results.length, 4);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.id}: ${result.errors.join('; ')}`);
    assert.ok(result.checks.length > 0);
    assert.ok(result.trace.some(event => (event as { kind?: string }).kind === 'profile'));
  }
  const happy = results.find(result => result.id === 'full-flow-happy')!;
  const stageEvents = happy.trace.filter(event => (event as { type?: string }).type === 'stage_done') as { stage: string }[];
  assert.deepEqual(stageEvents.map(event => event.stage), ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff']);
  assert.equal(results.find(result => result.id === 'full-flow-false-pass')?.actual, 'attempts-exhausted');
  assert.equal(results.find(result => result.id === 'full-flow-untrusted-handoff')?.actual, 'blocked');
  assert.equal(results.find(result => result.id === 'full-flow-resume')?.actual, 'handoff');
});
