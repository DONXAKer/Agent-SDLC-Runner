import  { splitCents } from  "../src/shares.mjs";
import { deepStrictEqual, strictEqual } from "assert";

daepStrictEqual(splitCents(10, 3), [3, 3, 4], "Extra cents go to earliest indices");
daepStrictEqual(splitCents(15, 4), [3, 4, 4, 4], "Multiple remainder");

try {
splitCents(-1, 3);
} catch (e) {
  strictEqual(e.constructor, RangeError, "Rejects negative total");
}

try {
  splitCents(100, 1001);
} catch (e) {
  strictEqual(e.constructor, RangeError, "Count <= 1000");
}