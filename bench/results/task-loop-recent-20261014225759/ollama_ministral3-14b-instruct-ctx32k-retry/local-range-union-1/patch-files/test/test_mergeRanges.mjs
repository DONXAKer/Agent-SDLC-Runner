import assert from 'node:assert';
import { mergeRanges } from '../src/ranges.mjs';

// Test 1: Basic merge (overlapping and touching)
const test1 = mergeRanges([
    [10, 20],
    [15, 25],  // overlaps
    [30, 40],
    [35, 45],  // overlaps
    [41, 50],  // touches
    [60, 70]
]);
assert.deepEqual(
    test1,
    [ [10, 25], [30, 50], [60, 70] ],
    'Should merge overlapping and touching ranges'
);

// Test 2: No merging (disjoint ranges)
const test2 = mergeRanges([ [1, 2], [3, 4], [5, 6] ]);
assert.deepEqual( test2, [ [1, 2], [3, 4], [5, 6] ], 'Disjoint ranges should remain untouched' );

// Test 3: Empty input
assert.deepEqual( mergeRanges([]), [], 'Empty input should yield empty array' );

// Test 4: Single range
assert.deepEqual( mergeRanges([ [10, 20] ]), [ [10, 20] ], 'Single range should return unchanged' );

// Test 5: Type check (non-array)
assert.throws(
    () => mergeRanges('not an array'),
    TypeError, 'Should throw on non-array input'
);

// Test 6: Invalid range structure
assert.throws(
    () => mergeRanges([ [1, 2, 3] ]),
    TypeError, 'Should throw on invalid range structure'
);

// Test 7: Non-finite numbers
assert.throws(
    () => mergeRanges([ [Infinity, Infinity] ]),
    TypeError, 'Should throw on non-finite endpoints'
);

// Test 8: Start > end
assert.throws(
    () => mergeRanges([ [20, 10] ]),
    TypeError, 'Should throw on reversed range'
);

// Test 9: Non-numbers
assert.throws(
    () => mergeRanges([ [NaN, 20] ]),
    TypeError, 'Should throw on NaN endpoints'
);

console.log('mergeRanges tests passed!');