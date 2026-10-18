import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectV4HoldoutModels, seriesCases, type SeriesRun } from '../../tools/guided-series.ts';

test('v4 smoke and paired comparison have fixed sizes and alternate ordering', () => {
  const models = ['a', 'b', 'c', 'd']; const tasks = ['add-validator', 'config-default'];
  assert.equal(seriesCases(models, tasks, [4], 1).length, 8);
  const paired = seriesCases(models, tasks, [3, 4], 3);
  assert.equal(paired.length, 48);
  assert.deepEqual(paired.slice(0, 4).map(c => c.version), [3, 4, 4, 3]);
});
test('holdout requires per-task reliability, rejects duplicate samples and ranks eligible models', () => {
  const runs: SeriesRun[] = seriesCases(['a', 'b', 'c'], ['add-validator', 'config-default'], [4], 3).map(c => ({ ...c,
    status: 'success', success: c.model !== 'c' || c.task === 'add-validator' || c.repeat === 1, tokens: c.model === 'b' ? 10 : 20, minutes: 1 }));
  assert.deepEqual(selectV4HoldoutModels(runs), ['b', 'a']);
  assert.deepEqual(selectV4HoldoutModels([...runs, runs[0]!]), ['b']);
  assert.deepEqual(selectV4HoldoutModels(runs.map(r => ({ ...r, falseSuccess: r.model === 'b' }))), ['a']);
});
