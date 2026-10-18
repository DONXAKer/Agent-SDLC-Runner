import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges} from '../src/ranges.mjs';

test('mergeRanges merges overlapping and touching ranges', () => {
  const input = [
    [1, 3],
    [2, 5],
    [5, 8],
    [10, 12],
    [0, 0],
  ];
  const result = mergeRanges(input);
  assert.deepEqual(result, [
    [0, 0],
    [1, 8],
    [10, 12],
  ]);
  // input not mutated
  assert.deepEqual(input, [
    [1, 3],
    [2, 5],
    [5, 8],
    [10, 12],
    [0, 0],
  ]);
  // output pairs are fresh arrays, not shared with input
  assert.ok(!result.some((r, i) => r === input.find((p) => p[0] === r[0] && p[1] === r[1])));
});

test('mergeRanges on empty input returns []', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('mergeRanges sorts unsorted input', () => {
  assert.deepEqual(mergeRanges([[10, 20], [1, 3], [2, 4]]), [
    [1, 4],
    [10, 20],
  ]);
});

test('mergeRanges throws TypeError on invalid input', () => {
  assert.throws(() => mergeRanges(null), TypeError);
  assert.throws(() => mergeRanges([[1]]), TypeError);
  assert.throws(() => mergeRanges([[1, 2, 3]]), TypeError);
  assert.throws(() => mergeRanges([[2, 1]]), TypeError);
  assert.throws(() => mergeRanges([[Infinity, 5]]), TypeError);
  assert.throws(() => mergeRanges([[1, NaN]]), TypeError);
  assert.throws(() => mergeRanges([['a', 1]]), TypeError);
  assert.throws(() => mergeRanges([[{0: 1}]]), TypeError);
});
