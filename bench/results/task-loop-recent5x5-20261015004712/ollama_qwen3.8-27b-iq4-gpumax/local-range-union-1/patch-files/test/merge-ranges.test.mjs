import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges, protocolVersion} from '../src/ranges.mjs';

test('empty input returns empty array', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('overlaps, containment, and touching merge, sorted output', () => {
  assert.deepEqual(
    mergeRanges([[5, 7], [1, 3], [2, 4], [9, 11], [7, 9]]),
    [
      [1, 4],
      [5, 11],
    ],
  );
  assert.deepEqual(mergeRanges([[1, 5], [2, 3]]), [[1, 5]]);
  assert.deepEqual(mergeRanges([[3, 5], [1, 10]]), [[1, 10]]);
  assert.deepEqual(mergeRanges([[2, 2], [2, 2]]), [[2, 2]]);
  assert.deepEqual(mergeRanges([[1, 2], [4, 6]]), [
    [1, 2],
    [4, 6],
  ]);
});

test('does not mutate input and shares no pair arrays with it', () => {
  const a = [2, 6];
  const b = [1, 3];
  const input = [a, b];
  const out = mergeRanges(input);
  assert.deepEqual(input, [a, b]);
  assert.notEqual(out[0], a);
  assert.notEqual(out[0], b);
  out[0][1] = 999;
  assert.deepEqual(input, [
    [2, 6],
    [1, 3],
  ]);
});

test('throws TypeError on invalid pairs, reversed endpoints or nonfinite numbers', () => {
  assert.throws(() => mergeRanges([[1]]), TypeError);
  assert.throws(() => mergeRanges([1, 3]), TypeError);
  assert.throws(() => mergeRanges([[2.5, 1]]), TypeError);
  assert.throws(() => mergeRanges([[1, 'x']]), TypeError);
  assert.throws(() => mergeRanges([[null, 1]]), TypeError);
  assert.throws(() => mergeRanges([[1, NaN]]), TypeError);
  assert.throws(() => mergeRanges([[-Infinity, 1]]), TypeError);
  assert.throws(() => mergeRanges('nope'), TypeError);
});

test('existing export preserved', () => {
  assert.equal(protocolVersion, 1);
});
