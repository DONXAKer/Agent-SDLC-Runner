import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges} from '../src/ranges.mjs';

test('mergeRanges with empty input', () => {
  assert.deepStrictEqual(mergeRanges([]), []);
});

test('mergeRanges with single range', () => {
  assert.deepStrictEqual(mergeRanges([[1, 3]]), [[1, 3]]);
});

test('mergeRanges with non-overlapping ranges', () => {
  assert.deepStrictEqual(mergeRanges([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
});

test('mergeRanges with overlapping ranges', () => {
  assert.deepStrictEqual(mergeRanges([[1, 3], [2, 4]]), [[1, 4]]);
});

test('mergeRanges with touching ranges', () => {
  assert.deepStrictEqual(mergeRanges([[1, 2], [2, 3]]), [[1, 3]]);
});

test('mergeRanges with multiple merges', () => {
  assert.deepStrictEqual(mergeRanges([[1, 2], [2, 3], [4, 5]]), [[1, 3], [4, 5]]);
});

test('mergeRanges with invalid pair', () => {
  assert.throws(() => mergeRanges([[1]]), TypeError);
});

test('mergeRanges with nonfinite number', () => {
  assert.throws(() => mergeRanges([[1, Infinity]]), TypeError);
});

test('mergeRanges with reversed endpoints', () => {
  assert.throws(() => mergeRanges([[2, 1]]), TypeError);
});