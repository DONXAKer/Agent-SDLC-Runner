import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocolVersion, mergeRanges } from '../src/ranges.mjs';

test('protocolVersion remains exported', () => {
  assert.equal(protocolVersion, 1);
});

test('mergeRanges handles empty input', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('mergeRanges merges overlapping and touching ranges', () => {
  const input1 = [
    [1, 3],
    [2, 5],
    [5, 6],
    [8, 10]
  ];
  assert.deepEqual(mergeRanges(input1), [[1, 6], [8, 10]]);

  const input2 = [
    [10, 11],
    [0, 1],
    [1, 3],
    [2, 4]
  ];
  assert.deepEqual(mergeRanges(input2), [[0, 4], [10, 11]]);

  const input3 = [[1, 2]];
  assert.deepEqual(mergeRanges(input3), [[1, 2]]);

  const input4 = [
    [0, 0],
    [0, 0]
  ];
  assert.deepEqual(mergeRanges(input4), [[0, 0]]);
});

test('mergeRanges does not mutate input or share output pair arrays', () => {
  const first = [1, 5];
  const second = [5, 10];
  const input = [first, second];
  const snapshot = [
    [20, 30],
    [15, 40]
  ];

  const result = mergeRanges(input);

  assert.deepEqual(result, [[1, 10]]);
  assert.deepEqual(input, [first, second]);
  assert.notEqual(result[0], first);
  assert.notEqual(result[0], second);
  assert.notEqual(result, snapshot);

  snapshot[0][0] = -1;
  assert.equal(result[0][0], 1);
});

test('mergeRanges rejects invalid pairs, reversed endpoints, and nonfinite numbers', () => {
  assert.throws(() => mergeRanges([[1, 2, 3]]), TypeError);
  assert.throws(() => mergeRanges([['1', 2]]), TypeError);
  assert.throws(() => mergeRanges([null]), TypeError);
  assert.throws(() => mergeRanges([1]), TypeError);
  assert.throws(() => mergeRanges([{}]), TypeError);
  assert.throws(() => mergeRanges([[2, 1]]), TypeError);
  assert.throws(() => mergeRanges([[Number.POSITIVE_INFINITY, 1]]), TypeError);
  assert.throws(() => mergeRanges([[1, Number.NEGATIVE_INFINITY]]), TypeError);
  assert.throws(() => mergeRanges([[Number.NaN, 1]]), TypeError);
  assert.throws(() => mergeRanges([[]]), TypeError);
});
