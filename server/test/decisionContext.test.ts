import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { decisionOptions } from '../src/run/decisionContext.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';

test('packet source text is checked against current files independently of historical receipts',t=>{
 const root=mkdtempSync(join(tmpdir(),'decision-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'lib'));const text='export const value = 2;\n';writeFileSync(join(root,'lib/value.ts'),text);
 const options=decisionOptions(new WitokPaths(root,'case'),'chunk',10000);
 assert.doesNotThrow(()=>options.validateQuestion([{sources:[{file:'request-1',text:'User request; not a filesystem source'}]}]),'A named request is data, not a file path');
 const hash=createHash('sha256').update(text).digest('hex');
 assert.doesNotThrow(()=>options.validateQuestion([{files:[{path:'lib/value.ts',hash,content:text}]}]));
 assert.throws(()=>options.validateQuestion([{source:{path:'lib/value.ts',content:'export const value = 1;'}}]),/stale/);
 writeFileSync(join(root,'lib/value.ts'),'export const value = 3;');
 assert.throws(()=>options.validateQuestion([{files:[{path:'lib/value.ts',hash,content:text}]}]),/hash changed/);
 assert.throws(()=>options.validateQuestion([{source:{path:'../escape.ts',content:'x'}}]),/escapes/);
 assert.throws(()=>options.validateQuestion([{files:[{path:'lib/value.ts',isNew:true}]}]),/already exists/);
});
