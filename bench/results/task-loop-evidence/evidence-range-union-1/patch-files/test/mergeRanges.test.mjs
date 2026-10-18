import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges, protocolVersion} from '../src/ranges.mjs';

test('empty input returns empty array', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('merges overlapping and touching ranges and sorts output', () => {
  const input = [[5, 7], [1, 2], [3, 5.5], [10, 11], [9, 10]];
  assert.deepEqual(mergeRanges(input), [[1, 2], [3, 7], [9, 11]]);
});

test('does not mutate input or share output pair arrays', () => {
  const input = [[5, 7], [1, 9]];
  const snapshot = input.map((p) => [...p]);
  const result = mergeRanges(input);
  assert.deepEqual(input, snapshot);
  for (const pair of result) {
    assert.ok(!input.includes(pair));
  }
});

test('zero- and single-element ranges', () => {
  assert.deepEqual(mergeRanges([[3, 3]]), [[3, 3]]);
  assert.deepEqual(mergeRanges([[2, 2], [4, 4]]), [[2, 2], [4, 4]]);
});

test('throws TypeError on non-array input', () => {
  assert.throws(() => mergeRanges(null), TypeError);
  assert.throws(() => mergeRanges('nope'), TypeError);
});

test('throws TypeError on invalid pairs', () => {
  assert.throws(() => mergeRanges([1, 3]), TypeError);
  assert.throws(() => mergeRanges([[1]]), TypeError);
  assert.throws(() => mergeRanges([[1, 2, 3]]), TypeError);
});

test('throws TypeError on nonfinite endpoints', () => {
  assert.throws(() => mergeRanges([[1, Infinity]]), TypeError);
  assert.throws(() => mergeRanges([[NaN, 2]]), TypeError);
});

test('throws TypeError on reversed endpoints', () => {
  assert.throws(() => mergeRanges([[5, 1]]), TypeError);
});

test('preserves existing export', () => {
  assert.equal(protocolVersion, 1);
});
