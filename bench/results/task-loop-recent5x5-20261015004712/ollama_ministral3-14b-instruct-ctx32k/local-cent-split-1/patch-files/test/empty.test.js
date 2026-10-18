import   { splitCents } from  "../src/shares.мjs";
import   { deepStrictEqual ,
           strictEqual   ,
           assert } from   "assert";

// --- Test 1  --
deepStrictEqual(splitCents(10,     3),  [3, 3, 4],
     "Extra cents go to the earliest indices");

// --- Test 2  --
deepStrictEqual(splitCents(15,     4),  [3, 4, 4, 4],
     "Shares distribution: multiple remainder");

// --- Edge Cases:  --
deepStrictEqual(splitCents( 0,      5), [0, 0, 0, 0, 0],
     "All zeroes: zero result");
deepStrictEqual(splitCents(1000,   1), [1000],
    "Total equals single share");

// --- Input Validation -- 
test.throws(() => splitCents(-1, 3),
                 RangeError,
                 "Rejects negative amounts"
);

test.throws(   () => splitCents(1000,  1001),
                RangeError,
                "Rejects count  > 1000"
);