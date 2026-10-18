import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/inventory.mjs")).href);
const fn=mod["createInventory"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); const initial={p:4}; const a=fn(initial); initial.p=0; assert.equal(a.available('p'),4); const t=a.reserve('p',3); assert.notEqual(t,null); assert.equal(a.available('p'),1); assert.equal(a.release(t),true); assert.equal(a.release(t),false); assert.equal(a.available('p'),4); });
