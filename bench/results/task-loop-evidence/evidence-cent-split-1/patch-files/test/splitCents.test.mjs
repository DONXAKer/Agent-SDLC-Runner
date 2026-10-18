import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents, protocolVersion} from '../src/shares.mjs';

test('protocolVersion is preserved', () => {
  assert.equal(protocolVersion, 1);
});

test('exact division', () => {
  assert.deepEqual(splitCents(100, 4), [25, 25, 25, 25]);
});

test('remainder goes to earliest indices', () => {
  assert.deepEqual(splitCents(10, 3), [4, 3, 3]);
  assert.deepEqual(splitCents(7, 4), [2, 2, 2, 1]);
});

test('zero total', () => {
  assert.deepEqual(splitCents(0, 5), [0, 0, 0, 0, 0]);
});

test('single share gets everything', () => {
  assert.deepEqual(splitCents(12345, 1), [12345]);
});

test('sum is preserved and max-min <= 1', () => {
  for (const [total, count] of [[1, 1000], [999, 999], [1000000, 1000]]) {
    const shares = splitCents(total, count);
    assert.equal(shares.length, count);
    assert.ok(shares.every((s) => Number.isInteger(s)));
    assert.equal(shares.reduce((a, b) => a + b, 0), total);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
    const extra = total % count;
    for (let i = 0; i < count - 1; i++) {
      assert.equal(shares[i] - shares[i + 1], i < extra ? 1 : 0);
    }
  }
  // Independent check of the big case
  const big = splitCents(999999999999, 997);
  assert.equal(big.length, 997);
  assert.equal(big.reduce((a, b) => a + b, 0), 999999999999);
  const bmin = Math.min(...big);
  const bmax = Math.max(...big);
  assert.ok(bmax - bmin <= 1);
  const bextra = 999999999999 % 997;
  // exactly `bextra` shares should be bmax, remaining should be bmin
  assert.equal(big.filter(s => s === bmax).length, bextra);
  assert.equal(big.filter(s => s === bmin).length, 997 - bextra);
});

test('rejects invalid total', () => {
  for (const total of [-1, 0.5, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN, '10', null, undefined]) {
    assert.throws(() => splitCents(total, 2), RangeError);
  }
});

test('rejects invalid count', () => {
  for (const count of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN, '2', null, undefined, 1001]) {
    assert.throws(() => splitCents(10, count), RangeError);
  }
});
