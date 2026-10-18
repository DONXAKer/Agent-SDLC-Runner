import  { splitCents      }     from "../src/shares.mjs";
import { strictEqual  }     from "assert";

// --- Test order-presured and distribution ---
strictEqual(JSON.stringify(splitCents(10, 3) ), 
            JSON.stringify([3, 3, 4]),
           "Test: extra cents go to earliest indices");
strictEqual(JSON.stringify(splitCents(15, 4)), 
            JSON.stringify([3, 4, 4, 4]),
            "Test: multiple remainder handled");
strictEqual(JSON.stringify(splitCents(0,  5)), "[0,0,0,0,0]",
            "Test: zero total, all zero shares");

// --- Test boundaries ---
strictEqual(JSON.stringify(splitCents(1000, 1)),
            "[1000]",
             "Test: single share equals total");

// --- Test validations ---
(function validate_throws_for_invalid_total() {
   try  {
      splitCents(-1,  3);  // negative total
      strictEqual(false, true,
                  "No RangeError for total < 0");
   } catch(e)  {
      strictEqual(e.name,  "RangeError",
                  "RangeError thrown when total is negative")
   }
})();

(function validate_throws_for_invalid_count() {
   try {
      splitCents(1000, 1001);  // count > 1000
      strictEqual(false, true,
                  "No RangeError for count > 1000");
   } catch(e) {
      strictEqual(e.name,  "RangeError",
                  "RangeError thrown for count > 1000");
   }
})();