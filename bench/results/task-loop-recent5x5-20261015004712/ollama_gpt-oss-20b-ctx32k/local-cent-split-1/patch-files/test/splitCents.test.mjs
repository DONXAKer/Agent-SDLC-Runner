import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents, protocolVersion} from '../src/shares.mjs';

// Helper to sum array
const sum = arr => arr.reduce((a, b) => a + b, 0);

// Basic correctness
test('splitCents: basic split', () => {
  const total = 10;
  const count = 3;
  const shares = splitCents(total, count);
  assert.strictEqual(shares.length, count);
  assert.strictEqual(sum(shares), total);
  // Differences at most 1
  const max = Math.max(...shares);
  const min = Math.min(...shares);
  assert.ok(max - min <= 1);
  // Extra cents go to earliest indices
  assert.ok(shares[0] >= shares[1] && shares[1] >= shares[2]);
});

// Zero total
test('splitCents: zero total', () => {
  const total = 0;
  const count = 5;
  const shares = splitCents(total, count);
  assert.deepStrictEqual(shares, Array(count).fill(0));
});

// Exact division
test('splitCents: exact division', () => {
  const total = 1000;
  const count = 1000;
  const shares = splitCents(total, count);
  assert.ok(shares.every(v => v === 1));
});

// Range errors
test('splitCents: invalid parameters', () => {
  assert.throws(() => splitCents(-1, 2), RangeError);
  assert.throws(() => splitCents(1.5, 2), RangeError);
  assert.throws(() => splitCents(10, 0), RangeError);
  assert.throws(() => splitCents(10, 1001), RangeError);
});
