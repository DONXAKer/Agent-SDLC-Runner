import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCents} from '../src/shares.mjs';

test('splitCents function', () => {
  // Test basic split
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
  
  // Test exact split
  assert.deepEqual(splitCents(90, 3), [30, 30, 30]);
  
  // Test single share
  assert.deepEqual(splitCents(50, 1), [50]);
  
  // Test remainder distribution
  assert.deepEqual(splitCents(101, 4), [26, 25, 25, 25]);
});