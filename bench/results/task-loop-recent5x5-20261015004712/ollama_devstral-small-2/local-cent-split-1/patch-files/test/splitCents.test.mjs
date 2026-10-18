import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protocolVersion, splitCents} from '../src/shares.mjs';

test('splitCents basic functionality', () => {
  // Test basic split
  assert.deepStrictEqual(splitCents(10, 3), [4, 3, 3]);
  assert.deepStrictEqual(splitCents(10, 2), [5, 5]);
  assert.deepStrictEqual(splitCents(10, 4), [3, 3, 2, 2]);
  
  // Test with remainder
  assert.deepStrictEqual(splitCents(10, 3), [4, 3, 3]);
  assert.deepStrictEqual(splitCents(11, 3), [4, 4, 3]);
  
  // Test edge cases
  assert.deepStrictEqual(splitCents(0, 1), [0]);
  assert.deepStrictEqual(splitCents(0, 2), [0, 0]);
  assert.deepStrictEqual(splitCents(1, 1), [1]);
  
  // Test max count
  assert.deepStrictEqual(splitCents(1000, 1000), Array(1000).fill(1));
});

test('splitCents input validation', () => {
  // Test invalid total
  assert.throws(() => splitCents(-1, 1), RangeError);
  assert.throws(() => splitCents(1.5, 1), RangeError);
  assert.throws(() => splitCents(Number.MAX_SAFE_INTEGER + 1, 1), RangeError);
  
  // Test invalid count
  assert.throws(() => splitCents(1, 0), RangeError);
  assert.throws(() => splitCents(1, -1), RangeError);
  assert.throws(() => splitCents(1, 1001), RangeError);
  assert.throws(() => splitCents(1, 1.5), RangeError);
});

test('existing public API', () => assert.equal(protocolVersion, 1));
