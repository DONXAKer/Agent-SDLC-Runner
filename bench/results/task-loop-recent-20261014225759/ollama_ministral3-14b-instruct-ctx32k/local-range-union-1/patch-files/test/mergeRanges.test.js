import { describe, it } from "deno:test";
import { mergeRanges } from "../src/ranges.мjs";

describe("mergeRanges", ()  => {
 // Test empty input
  it("should return an empty array for empty input", () => {
    const result  = mergeRanges([]);
    const expected  = [];
    assertArrayEqual(result, expected);
  });

 // Test ranges with no overlaps
  it("should return same ranges when no overlaps", () => {
    const ranges  = [[1, 3], [5, 7], [9, 11]];
    const expected  = [[1, 3], [5, 7], [9, 11]];
    assertArrayEqual(mergeRanges(ranges), expected);
  });

 // Test overlapping ranges
  it("should merge overlapping ranges", () => {
    const ranges  = [[1, 5], [3, 7]];
    const expected  = [[1, 7]];
    assertArrayEqual(mergeRanges(ranges), expected);
  });

 // Test touching ranges
  it("should merge touching ranges", () => {
    const ranges  = [[1, 2], [2, 4]];
    const expected  = [[1, 4]];
    assertArrayEqual(mergeRanges(ranges), expected);
  });

 // Test reversed/non-integer ranges
  it("should throw TypeError for invalid start > end", () => {
    const ranges  = [[1, 3], [5, 4]];
    try  {
      mergeRanges(ranges);
      throw new Error("TypeError not thrown");
    } catch  {
      if  (!(err instanceof TypeError))
        throw new Error("Non-TypeError caught");
     }
  });

 // Test nonfinite input
  it("should throw if start is nonfinite", () => {
    const ranges  = [[Infinity, 5], [1, 3]];
    try  {
      mergeRanges(ranges);
      throw new Error("TypeError not thrown")
    } catch  {
      if  (!(err instanceof TypeError))
        throw new Error("Non-TypeError caught")
    }
  });
});

function assertArrayEqual(actual, expected) {
  const  deepEqual  = JSON.stringify(actual)  === JSON.stringify(expected);
  if  (!deepEqual) {
    throw new Error(`Arrays unequal.
Actual:  ${JSON.stringify(actual)}
Expected:  ${JSON.stringify(expected)}
`);
   }
}