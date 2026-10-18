import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/expiry.mjs")).href);
const fn=mod["expiresAt"];
test('H1 [contract] public module contract',()=>{assert.equal(mod.protocolVersion,1);assert.equal(typeof fn,'function');});
test('H2 [behavior] independent boundary and sequence cases',async()=>{for(const n of [-100,0,98765]){assert.equal(fn(n),n+45000);assert.equal(fn(n,undefined),n+45000);assert.equal(fn(n,0),n);}for(const args of [[0,null],[0,-1],[0,NaN],[Infinity,0],[0,'1'],[Number.MAX_VALUE,Number.MAX_VALUE]])assert.throws(()=>fn(...args),RangeError);});
