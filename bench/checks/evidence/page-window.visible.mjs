import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/page.mjs")).href);
const fn=mod["pageAfter"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.deepEqual(fn([{id:'a'},{id:'b'}],null,1),{items:[{id:'a'}],nextCursor:'a'}); assert.throws(()=>fn([{id:'a'}],'unknown',1),RangeError); });
