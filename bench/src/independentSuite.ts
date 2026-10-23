import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { acceptanceClaims } from '../../server/src/run/independentAcceptance.ts';
import type { Run } from '../../server/src/run/Run.ts';

/** Benchmark-only suites, authored from task input before the candidate exists. Never copy the hidden grader. */
export function prepareIndependentSuite(benchDir: string, task: string, fixture: string, directory: string, image: string) {
  const behavior = join(benchDir, 'acceptance', task + '.mjs');
  if (!existsSync(behavior)) throw Error(`No independently authored acceptance definition: ${task}`);
  mkdirSync(directory, { recursive: true });
  cpSync(behavior, join(directory, 'behavior.mjs'));
  const baseline: Record<string,string> = {};
  const walk = (dir:string) => { for (const e of readdirSync(dir, { withFileTypes:true })) {
    const path=join(dir,e.name); if(e.isSymbolicLink())throw Error('Fixture symlink');
    if(e.isDirectory())walk(path);else baseline[relative(fixture,path).replace(/\\/g,'/')]=readFileSync(path,'utf8');
  } };
  walk(join(fixture,'test'));
  writeFileSync(join(directory,'baseline.json'),JSON.stringify(baseline));
  const names=['approved task behavior','existing test policy','new tests and project checks'];
  writeFileSync(join(directory,'contract.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';
import {verifyBehavior,verifyExistingTests} from './behavior.mjs';
const root=process.env.SDLC_CANDIDATE_ROOT;
const baseline=JSON.parse(fs.readFileSync(new URL('./baseline.json',import.meta.url),'utf8'));
test(${JSON.stringify(names[0])},()=>verifyBehavior(root));
test(${JSON.stringify(names[1])},()=>verifyExistingTests(root,baseline));
test(${JSON.stringify(names[2])},()=>{
 const files=[];const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\\.test\\.(?:ts|mjs|js)$/.test(e.name))files.push(p);}};walk(path.join(root,'test'));
 assert.ok(files.some(f=>!Object.hasOwn(baseline,path.relative(root,f).replaceAll('\\\\','/'))),'a new test file is required');
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 for(const args of [['scripts/build-check.mjs'],['--test',...files]]){const p=cp.spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:20000});assert.equal(p.status,0,p.stdout+'\\n'+p.stderr);}
});\n`);
  return async (run:Run) => {
    const claims=acceptanceClaims(run.paths).filter(c=>!c.tags?.includes('manual'));
    return run.registerIndependentAcceptance({sourceDir:directory,image,
      author:{kind:'model',id:'codex:independent-benchmark-author'},qualification:'Fixed suite authored from the original benchmark task before candidate implementation; not the executor model',
      checks:claims.flatMap(c=>names.map(name=>({claimId:c.id,file:'contract.test.mjs',name}))),
      limitations:'Finite original-task tests; whole-contract suite shared by claims, not a proof of each generated claim or unseen behavior. Independent hidden grader remains separate. Benchmark operator approvals are automated.'});
  };
}
