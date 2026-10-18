import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges} from '../src/ranges.mjs';

test('merges overlapping and touching ranges', () => {
  assert.deepEqual(
    mergeRanges([[1, 3], [2, 5], [6, 8], [10, 12]]),
    [[1, 5], [6, 8], [10, 12]],
  );
});

test('sorts and merges unsorted input', () => {
  assert.deepEqual(
    mergeRanges([[5, 7], [1, 3], [2, 4], [10, 10]]),
    [[1, 4], [5, 7], [10, 10]],
  );
});

test('nested ranges collapse', () => {
  assert.deepEqual(
    mergeRanges([[1, 10], [2, 3], [4, 5]]),
    [[1, 10]],
  );
});

test('empty input returns empty array', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('does not mutate input or share pair arrays', () => {
  const input = [[1, 4], [9, 11]];
  const snapshot = input.map((p) => [...p]);
  const result = mergeRanges(input);
  assert.deepEqual(input, [[1, 4], [9, 11]]);
  // input pairs not mutated
  assert.deepEqual(input, snapshot);
  // output pairs are fresh arrays, not shared with input
  for (const outPair of result) {
    assert.ok(!input.includes(outPair));
  }
  // mutation of output does not affect input, and vice versa
  result[0][1] = 123;
  assert.deepEqual(input, snapshot);
});

test('zero-length and equal ranges', () => {
  assert.deepEqual(
    mergeRanges([[5, 5], [5, 5], [3, 4], [4, 6]]),
    [[3, 6]],
  );
  assert.deepEqual(mergeRanges([[5, 5]]), [[5, 5]]);
});

test('throws TypeError on non-array input', () => {
  assert.throws(() => mergeRanges('nope'), TypeError);
  assert.throws(() => mergeRanges(null), TypeError);
  assert.throws(() => mergeRanges(), TypeError);
});

test('throws TypeError on non-array pair', () => {
  assert.throws(() => mergeRanges([[1, 2], 'bad']), TypeError);
  assert.throws(() => mergeRanges([42]), TypeError);
});

test('throws TypeError on non-finite or non-number endpoints', () => {
  assert.throws(() => mergeRanges([[1, NaN]]), TypeError);
  assert.throws(() => mergeRanges([[Infinity, 5]]), TypeError);
  assert.throws(() => mergeRanges([[-Infinity, 5]]), TypeError);
  assert.throws(() => mergeRanges([['a', 2]]), TypeError);
});

test('throws TypeError on reversed endpoints', () => {
  assert.throws(() => mergeRanges([[5, 2]]), TypeError);
});
