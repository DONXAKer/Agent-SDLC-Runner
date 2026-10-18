import { strict as assert } from 'assert';
import { mergeRanges, protocolVersion } from '../src/ranges.mjs';

// Tests for mergeRanges
// Edge cases

assert.deepStrictEqual(mergeRanges([]), []);

// Single range

assert.deepStrictEqual(mergeRanges([
    [1, 2]
]), [
    [1, 2]
]);

// Already merged (non-overlapping non-touching) ranges

assert.deepStrictEqual(mergeRanges([
    [1, 3], 
    [4, 6], 
    [7, 10]
]), [
    [1, 3],
    [4, 6],
    [7, 10]
]);

// No overlaps but ranges are touching eachother to be merged

assert.deepStrictEqual(mergeRanges([
    [1, 2], 
    [2, 4], 
    [7, 9]
]), [
    [1, 4],
    [7, 9]
]);

// Many overlapping ranges

assert.deepStrictEqual(mergeRanges([
    [1, 5], 
    [2, 7],
    [3, 8]
]), [
    [1, 8]
]);

// Ranges with large overlaps

assert.deepStrictEqual(mergeRanges([
    [1, 3],
    [-10, 0], 
    [6, 8]
]), [
    [-10, 0],
    [1, 8]
]);

const expected = [[0, 5], [6, 8], [9, 12]];
const inputRanges = [[0, 5], [1, 3], [5, 7], [6, 12], [9, 12], [0, 0]];
assert.deepStrictEqual(mergeRanges(inputRanges), expected);

console.log('All tests have passed');