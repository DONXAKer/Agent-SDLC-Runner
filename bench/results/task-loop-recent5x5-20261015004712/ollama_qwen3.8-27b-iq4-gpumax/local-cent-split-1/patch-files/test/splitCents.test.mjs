import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents, protocolVersion} from '../src/shares.mjs';

test('splitCents basic split', () => {
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
  assert.deepEqual(splitCents(0, 5), [0, 0, 0, 0, 0]);
  assert.deepEqual(splitCents(7, 1), [7]);
  const big = splitCents(100, 1000);
  assert.equal(big.length, 1000);
  assert.deepEqual(big.slice(0, 100).map((v) => v), new Array(100).fill(1));
  assert.deepEqual(big.slice(100).map((v) => v), new Array(900).fill(0));
});

test('splitCents sum and adjacency invariants', () => {
  for (const [total, count] of [[12345, 7], [Number.MAX_SAFE_INTEGER, 1000], [999, 1000], [1, 1000]]) {
    const shares = splitCents(total, count);
    assert.equal(shares.length, count);
    const sum = shares.reduce((a, b) => a + b, 0);
    assert.equal(sum, total);
    const min = Math.min(...shares);
    const max = Math.max(...shares);
    assert.ok(max - min <= 1);
    assert.ok(shares.every((s) => Number.isInteger(s)));
    // Earlier indices get the extras.
    for (let i = 1; i < count; i++) {
      assert.ok(shares[i - 1] >= shares[i]);
    }
  }
});

test('splitCents rejects invalid total', () => {
  for (const t of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity, '100', null, undefined]) {
    assert.throws(() => splitCents(t, 3), RangeError);
  }
});

test('splitCents rejects invalid count', () => {
  for (const c of [0, -1, 1.5, 1001, NaN, '3', null, undefined]) {
    assert.throws(() => splitCents(100, c), RangeError);
  }
});

test('existing export preserved', () => {
  assert.equal(protocolVersion, 1);
});
