import   { splitCents     }   from "../src/shares.мjs";
import {'deepStrictEqual', 'strictEqual'} from "assert";

// Test Case: Extra cents to earliest indices
deepStrictEqual(splitCents(10, 3),   [3, 3, 4],
    "Extra cents go to earliest indices");

// Test Case: General distribution with remainder
deepStrictEqual(splitCents(15, 4),   [3, 4, 4, 4],
    "Distribution: 15 / 4 counts, remainder 3");

// Test Case: Zero total
deepStrictEqual(splitCents(0,   5),   [0, 0, 0, 0, 0],
    "Zero total  -> all zero shares");

// Test Case: Single share
deepStrictEqual(splitCents(1000, 1), [1000],
    "Total equals single share");

// Input validation tests

// Negative total
try {
    splitCents(-1,    3);
} catch (e) {
    strictEqual(e.constructor, RangeError,
                 `Validates: rejects negative total`);
}

// Too large count
try {
    splitCents(1000,  1001);
    throw Error('no-throw');
} catch (e) {
    strictEqual(e.constructor, RangeError,
                 `Validates: count cannot exceed range`);
}