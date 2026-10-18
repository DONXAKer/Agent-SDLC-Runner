import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents} from '../src/shares.mjs';

test('splits 10 cents over 3 with extra cents to earliest indices', () => {
  assert.deepEqual(splitCents(10, 3), [4, 3, 3]);
});

test('even split has no extra cents', () => {
  assert.deepEqual(splitCents(10, 5), [2, 2, 2, 2, 2]);
});

test('zero total returns zeros', () => {
  assert.deepEqual(splitCents(0, 7), [0, 0, 0, 0, 0, 0, 0]);
});

test('count of 1 returns the whole total', () => {
  assert.deepEqual(splitCents(1234, 1), [1234]);
});

test('large total near safe integer limit stays exact', () => {
  const total = Number.MAX_SAFE_INTEGER;
  const shares = splitCents(total, 3);
  assert.ok(shares.every(Number.isInteger));
  assert.equal(shares.reduce((a, b) => a + b, 0), total);
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
});

test('throws RangeError for invalid total or count', () => {
  for (const bad of [
    [-1, 2], [1.5, 2], [Number.MAX_SAFE_INTEGER + 2, 2], ['10', 2], [null, 2], [NaN, 2],
    [10, 0], [10, -3], [10, 1001], [10, 1.25], [10, '3'], [10, undefined],
  ]) {
    assert.throws(() => splitCents(...bad), RangeError);
  }
});
