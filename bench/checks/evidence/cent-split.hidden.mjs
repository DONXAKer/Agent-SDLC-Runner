import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/shares.mjs")).href);
const fn=mod["splitCents"];
test('H1 [contract] public module contract',()=>{assert.equal(mod.protocolVersion,1);assert.equal(typeof fn,'function');});
test('H2 [behavior] independent boundary and sequence cases',async()=>{for(const total of [0,1,17,999,Number.MAX_SAFE_INTEGER]) for(const count of [1,2,7,31]) { const out=fn(total,count); assert.equal(out.length,count); assert.equal(out.reduce((s,v)=>s+BigInt(v),0n),BigInt(total)); assert.ok(out.every(Number.isSafeInteger)); assert.ok(out.every((v,i)=>v===Math.floor(total/count)+(i<total%count?1:0))); } for(const args of [[-1,2],[1.5,2],[3,1001],[3,NaN],[Infinity,2]]) assert.throws(()=>fn(...args),RangeError);});
