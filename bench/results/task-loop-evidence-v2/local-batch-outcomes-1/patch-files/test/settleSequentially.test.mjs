import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settleSequentially} from '../src/batch.mjs';

test('settleSequentially: sequential order, mixed sync/async results', async () => {
  const order = [];
  const items = [1, 2, 3];
  const results = await settleSequentially(items, async (item, index) => {
    order.push(index);
    if (item === 2) throw new Error('boom');
    await Promise.resolve();
    return item * 10;
  });
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], {ok: true, value: 10});
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.message, 'boom');
  assert.deepEqual(results[2], {ok: true, value: 30});
});

test('settleSequentially: sync throw and rejected promise preserved as-is', async () => {
  const syncErr = new TypeError('sync');
  const asyncErr = new RangeError('async');
  const results = await settleSequentially(['a', 'b'], (item) => {
    if (item === 'a') throw syncErr;
    return Promise.reject(asyncErr);
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, syncErr);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, asyncErr);
});

test('settleSequentially: empty input yields []', async () => {
  const results = await settleSequentially([], () => 1);
  assert.deepEqual(results, []);
});

test('settleSequentially: does not mutate items', async () => {
  const seen = [];
  const items = [1, 2, 3];
  await settleSequentially(items, (item, index) => {
    seen.push({item, index});
    return item;
  });
  assert.deepEqual(items, [1, 2, 3]);
  assert.deepEqual(seen, [{item: 1, index: 0}, {item: 2, index: 1}, {item: 3, index: 2}]);
});
