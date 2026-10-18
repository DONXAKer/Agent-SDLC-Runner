import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/options.mjs")).href);
const fn=mod["resolveOptions"];
test('V1 [visible] required export and public API',async()=>{
  assert.equal(typeof fn,'function', 'export resolveOptions as a function from src/options.mjs');
  assert.deepEqual(fn({a:2},{a:undefined,b:0}),{a:2,b:0});
  const p=Object.fromEntries([['__proto__',7]]);
  const out=fn({},p);
  assert.equal(typeof out,'object');
  assert.notEqual(out,null);
  const desc=Object.getOwnPropertyDescriptor(out,'__proto__');
  assert.notEqual(desc,undefined, 'own enumerable "__proto__" required');
  assert.equal(desc.value,7);
  assert.equal(desc.enumerable,true);
});
