import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/ranges.mjs")).href);
const fn=mod["mergeRanges"];
test('H1 [contract] public module contract',()=>{assert.equal(mod.protocolVersion,1);assert.equal(typeof fn,'function');});
test('H2 [behavior] independent boundary and sequence cases',async()=>{for(let n=1;n<19;n++){ const input=[[n+2,n+7],[n,n+3],[n+9,n+10]]; const copy=structuredClone(input); const out=fn(input); assert.deepEqual(out,[[n,n+7],[n+9,n+10]]); assert.deepEqual(input,copy); out[0][0]=-2; assert.deepEqual(input,copy); } for(const x of [[[4,2]],[[0,Infinity]],[[1]],null]) assert.throws(()=>fn(x),TypeError);});
