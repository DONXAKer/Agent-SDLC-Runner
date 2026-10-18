import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/shares.mjs")).href);
const fn=mod["splitCents"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.deepEqual(fn(10,3),[4,3,3]); assert.throws(()=>fn(1,0),RangeError); const big=fn(Number.MAX_SAFE_INTEGER,2); assert.equal(big.length,2); assert.equal(big[0]+big[1],Number.MAX_SAFE_INTEGER); assert.equal(Math.max(...big)-Math.min(...big),1); });
