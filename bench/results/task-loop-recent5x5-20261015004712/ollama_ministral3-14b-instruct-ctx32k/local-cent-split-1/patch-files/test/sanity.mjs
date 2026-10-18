import { splitCents } from "../src/shares.мjs";
deepStrictEqual(splitCents(10, 3), [3, 3, 4])
	   .strictEqual(splitCents(15, 4), [3, 4, 4, 4])
	    .strictEqual(splitCents(0, 5).toString() , "0,0,0,0,0")
	  .catch((e) => strictEqual(e.constructor, RangeError))
	  .catch(splitCents(-1, 3))
	  .catch((e) => strictEqual(e.constructor, RangeError))