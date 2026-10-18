import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settleSequentially} from '../src/batch.mjs';

test('empty input yields []', async () => {
  const results = await settleSequentially([], async () => 'unused');
  assert.deepEqual(results, []);
});

test('resolves each item once, in input order', async () => {
  const calls = [];
  const results = await settleSequentially(['a', 'b'], async (item, index) => {
    calls.push(`${item}:${index}`);
    return item.toUpperCase();
  });
  assert.deepEqual(results, [
    {ok: true, value: 'A'},
    {ok: true, value: 'B'}
  ]);
  assert.deepEqual(calls, ['a:0', 'b:1']);
});

test('continues after errors and preserves the original error object', async () => {
  const boom = new Error('boom');
  const pending = new Error('pending');
  const seen = [];
  const results = await settleSequentially([1, 2, 3], async (item) => {
    seen.push(item);
    if (item === 1) { throw boom; }
    if (item === 2) { return Promise.reject(pending); }
    return item * 10;
  });
  assert.deepEqual(results, [
    {ok: false, error: boom},
    {ok: false, error: pending},
    {ok: true, value: 30}
  ]);
  assert.equal(results[0].error, boom);
  assert.equal(results[1].error, pending);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('awaits each work call before starting the next', async () => {
  const order = [];
  const results = await settleSequentially(['x', 'y'], async (_item, index) => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push(index);
    return true;
  });
  assert.deepEqual(order, [0, 1]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true]
  );
});

test('does not mutate the input array', async () => {
  const items = [1, 2, 3];
  const deepCopy = JSON.parse(JSON.stringify(items));
  const results = await settleSequentially(items, async () => items);
  assert.deepEqual(items, deepCopy);
  assert.deepEqual(results[0].value, deepCopy);
  assert.equal(results[0].value, items);
});
