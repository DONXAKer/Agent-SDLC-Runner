import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges} from '../src/ranges.mjs';

test('mergeRanges with empty input', () => {
  assert.deepEqual(mergeRanges([]), []);
});

test('mergeRanges with single range', () => {
  assert.deepEqual(mergeRanges([[1, 3]]), [[1, 3]]);
});

test('mergeRanges with non-overlapping ranges', () => {
  assert.deepEqual(mergeRanges([[1, 3], [5, 7]]), [[1, 3], [5, 7]]);
});

test('mergeRanges with overlapping ranges', () => {
  assert.deepEqual(mergeRanges([[1, 3], [2, 4]]), [[1, 4]]);
});

test('mergeRanges with touching ranges', () => {
  assert.deepEqual(mergeRanges([[1, 3], [3, 5]]), [[1, 5]]);
});

test('mergeRanges with multiple merges', () => {
  assert.deepEqual(mergeRanges([[1, 4], [2, 3], [5, 7], [6, 8]]), [[1, 4], [5, 8]]);
});

test('mergeRanges throws on invalid pair format', () => {
  assert.throws(() => mergeRanges([[1]]), TypeError);
  assert.throws(() => mergeRanges([1, 2]), TypeError);
});

test('mergeRanges throws on nonfinite numbers', () => {
  assert.throws(() => mergeRanges([[1, Infinity]]), TypeError);
  assert.throws(() => mergeRanges([[1, -Infinity]]), TypeError);
  assert.throws(() => mergeRanges([[NaN, 1]]), TypeError);
});

test('mergeRanges throws on reversed endpoints', () => {
  assert.throws(() => mergeRanges([[3, 1]]), TypeError);
});