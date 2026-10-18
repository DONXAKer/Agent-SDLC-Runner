import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/expiry.mjs")).href);
const fn=mod["expiresAt"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.equal(fn(123,0),123); assert.equal(fn(123,10),133); assert.throws(()=>fn(0,null),RangeError); });
