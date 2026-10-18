import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path';
const mod=await import(pathToFileURL(resolve(process.env.BENCH_TARGET_DIR,"src/format.mjs")).href);
const fn=mod["csvRow"];
test('V1 [visible] required export and public API',async()=>{ assert.equal(typeof fn,'function'); assert.equal(fn(['a,b','c']), '"a,b",c'); assert.equal(fn([]),''); assert.equal(fn(['say "hi"']), '"say ""hi"""'); });
