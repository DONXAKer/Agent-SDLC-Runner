import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/batch.mjs")).href);
const fn=mod["settleSequentially"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.deepEqual(await fn([2,3],async(x,i)=>x+i),[{ok:true,value:2},{ok:true,value:4}]); const err=new Error('boom'); const out=await fn([1,2],async(x)=>{ if(x===1) throw err; return x; }); assert.equal(out[0].ok,false); assert.equal(out[0].error,err); assert.deepEqual(out[1],{ok:true,value:2}); });
