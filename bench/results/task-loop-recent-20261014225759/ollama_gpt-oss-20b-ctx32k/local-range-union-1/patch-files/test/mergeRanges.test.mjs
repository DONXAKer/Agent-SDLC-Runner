import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges, protocolVersion} from '../src/ranges.mjs';

test('mergeRanges basic', () => {
    const res = mergeRanges([[1,3], [2,4], [5,7]]);
    assert.deepEqual(res, [[1,4], [5,7]]);
});

test('mergeRanges touching', () => {
    const res = mergeRanges([[1,2], [2,3], [3,4]]);
    assert.deepEqual(res, [[1,4]]);
});

test('mergeRanges unsorted', () => {
    const res = mergeRanges([[5,6],[1,2]]);
    assert.deepEqual(res, [[1,2], [5,6]]);
});

test('mergeRanges empty', () => {
    assert.deepEqual(mergeRanges([]), []);
});

test('mergeRanges invalid', () => {
    assert.throws(() => mergeRanges([[3,1]]), TypeError);
    assert.throws(() => mergeRanges([[2,'b']]), TypeError);
});
