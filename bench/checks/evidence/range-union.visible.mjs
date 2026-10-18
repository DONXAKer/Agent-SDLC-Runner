import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/ranges.mjs")).href);
const fn=mod["mergeRanges"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.deepEqual(fn([[3,5],[1,3]]),[[1,5]]); assert.deepEqual(fn([]),[]); const input=[[1,2]]; const copy=structuredClone(input); const out=fn(input); out[0][0]=-9; assert.deepEqual(input,copy); assert.throws(()=>fn([[4,2]]),TypeError); });
