import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/format.mjs")).href);
const fn=mod["csvRow"];
test('H1 [contract] public module contract',()=>{assert.equal(mod.protocolVersion,1);assert.equal(typeof fn,'function');});
test('H2 [behavior] independent boundary and sequence cases',async()=>{assert.equal(fn(['say "hi"','a\rb','x\ny','', '  Ж  ']),'"say ""hi""","a\rb","x\ny",,  Ж  '); const xs=['','',',','"']; const cp=[...xs]; assert.equal(fn(xs),',,",",""""'); assert.deepEqual(xs,cp);});
