import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents, protocolVersion} from '../src/shares.mjs';

test('splitCents basic', () => {
  assert.deepEqual(splitCents(10, 3), [4, 3, 3]);
  assert.deepEqual(splitCents(0, 5), [0, 0, 0, 0, 0]);
  assert.deepEqual(splitCents(7, 1000).filter(v => v !== 0).length, 7);
  assert.equal(splitCents(7, 1000).reduce((a, b) => a + b, 0), 7);
});

test('splitCents extra goes to earliest indices', () => {
  assert.deepEqual(splitCents(7, 3), [3, 2, 2]);
  assert.deepEqual(splitCents(100, 10), Array(10).fill(10));
});

test('splitCents throws RangeError on bad input', () => {
  assert.throws(() => splitCents(-1, 3), RangeError);
  assert.throws(() => splitCents(1.5, 3), RangeError);
  assert.throws(() => splitCents(NaN, 3), RangeError);
  assert.throws(() => splitCents(Infinity, 3), RangeError);
  assert.throws(() => splitCents(10, 0), RangeError);
  assert.throws(() => splitCents(10, -2), RangeError);
  assert.throws(() => splitCents(10, 1001), RangeError);
  assert.throws(() => splitCents(10, 0.5), RangeError);
  assert.throws(() => splitCents(10, undefined), RangeError);
});

test('protocolVersion preserved', () => {
  assert.equal(protocolVersion, 1);
});
