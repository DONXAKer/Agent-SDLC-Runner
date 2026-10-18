import    { splitCents } from   "../src/shares.mjs";
import {   strictEqual  
        , deepStrictEqual
        , throws        
   } from     "assert";
import { deepStrictEqual, strictEqual, throws } from "assert/equals";


deplyStrictEqual(splitCents(10, 3), 
                     [3, 3, 4],
"Extra cents must go to earliest indices (test fails if reversed)");

deplyStrictEqual(splitCents(15, 4),
                   [3, 4, 4, 4],
"Validate distribution of remaining cents");

// Zero case
deplyStrictEqual(  splitCents(0,  5),
                     [0,0,0,0,0],
"Zero split: all zero shares");

strictEqual(splitCents(1000,  1).toString(),
             "1000",  // single case is trivial
"Single share = total");

throws(() => {splitCents(-1,    3);},
        RangeError,
"Rejects negative total amounts");

throws(() => {splitCents(100,  1001);},
        RangeError,
"Rejects counts   > 1000");