import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkFrozenTree } from '../../tools/guided-matrix.ts';

test('frozen dependencies share file storage while retaining separate directory entries', t => {
  const root=mkdtempSync(join(tmpdir(),'frozen-deps-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),destination=join(root,'destination');
  mkdirSync(join(source,'package'),{recursive:true});
  writeFileSync(join(source,'package','index.js'),'export const value = 1;');
  linkFrozenTree(source,destination);
  assert.equal(readFileSync(join(destination,'package','index.js'),'utf8'),'export const value = 1;');
  assert.equal(statSync(join(source,'package','index.js')).ino,statSync(join(destination,'package','index.js')).ino);
  writeFileSync(join(destination,'new-cache-file'),'new');
  assert.throws(()=>readFileSync(join(source,'new-cache-file')));
});

test('a junction cannot redirect frozen dependency reuse outside its tree', t => {
  const root=mkdtempSync(join(tmpdir(),'frozen-deps-link-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'source'));mkdirSync(join(root,'outside'));
  symlinkSync(join(root,'outside'),join(root,'source','escape'),'junction');
  assert.throws(()=>linkFrozenTree(join(root,'source'),join(root,'destination')),/Symlink/);
});
