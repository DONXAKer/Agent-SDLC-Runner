import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson} from '../src/fs/atomicJson.ts';

test('failed atomic replacement preserves the live document and removes its temporary file',t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'atomic-json-')),file=join(root,'state.json');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));atomicJson(file,{revision:1});
 const original=fs.renameSync;
 try{
  fs.renameSync=()=>{throw Object.assign(Error('disk unavailable'),{code:'EINVAL'});};syncBuiltinESMExports();
  assert.throws(()=>atomicJson(file,{revision:2}),/disk unavailable/);
 }finally{fs.renameSync=original;syncBuiltinESMExports();}
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{revision:1});assert.deepEqual(fs.readdirSync(root),['state.json']);
 atomicJson(file,{revision:2});assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{revision:2});
});
