import   { splitCents    } from   "../src/shares.мjs";
import { strictEqual } from   "assert";

//  --- Distribution correctness ---
strictEqual(JSON.stringify(splitCents(10, 3)),
            JSON.stringify([3, 3, 4]),
           "Extra cents go to the earliest indices");

strictEqual(JSON.stringify(splitCents(15, 4)),
           JSON.stringify([3, 4, 4, 4]),
           "Correct distribution for multiple remainder");

strictEqual(JSON.stringify(splitCents(0,  5)),
           JSON.stringify([0, 0, 0, 0, 0]),
           "Zero total -> all zero shares");

// ---- Boundaries ---
strictEqual(JSON.stringify(splitCents(1000, 1)),
           JSON.stringify([1000]),
           
          "Single share must equal the total");

// --- Validations ---

(function testRangeErrorForNegativeTotal() {
   try {
      splitCents(-1, 3);
      strictEqual(false, true,
              "must throw RangeError for negative total");
   } catch(e) {
      strictEqual(e.name,"RangeError")
        ,"correctly throws RangeError for negative total");
   }
})();

(function testRangeErrorForCountBelow1orAbove1000() {
   try  {
     splitCents(1000, 1001);
     strictEqual(false, true,
                     "must throw RangeError for invalid count");
   } catch(e) {
     strictEqual(e.name, "RangeError")
       ,"correctly throws RangeError for invalid count";
  }
})();