import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {prepareIndependentSuite} from '../src/independentSuite.ts';
import {WitokPaths} from '../../server/src/artifacts/paths.ts';import {initGuided} from '../../server/src/run/guidedState.ts';
import {registerAcceptance,acceptanceProblem,runIndependentAcceptance} from '../../server/src/run/independentAcceptance.ts';
import type {Run} from '../../server/src/run/Run.ts';
const image=process.env.SDLC_TEST_DOCKER_IMAGE;
const bench=join(import.meta.dirname,'..');
for(const [task,family]of [['add-validator','billing'],['config-default','billing'],['vat-rounding','billing'],['rename-field','catalog'],['idempotent-retry','notify']] as const){
 test(`independent ${task} suite is executed and red on the original fixture`,{skip:!image},async t=>{
  const root=mkdtempSync(join(tmpdir(),'acceptance-fixture-')),suite=mkdtempSync(join(tmpdir(),'acceptance-suite-'));
  t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(suite,{recursive:true,force:true});});
  const fixture=join(bench,'fixtures',family);cpSync(fixture,root,{recursive:true});execFileSync('git',['init','-q'],{cwd:root});
  const paths=new WitokPaths(root,'case');initGuided(paths,'test',4);
  writeFileSync(paths.intent,'# Contract\n\n| id | Пункт | Как проверить |\n|---|---|---|\n| claim-1 | Original task behavior | Frozen independent suite |\n');
  writeFileSync(paths.plan,'# Plan\n\n- **Одобрение:** Benchmark operator, 2026-10-20\n');
  const freeze=prepareIndependentSuite(bench,task,fixture,suite,image!);
  const fake={paths,registerIndependentAcceptance:(input:unknown)=>registerAcceptance(paths,input,'Benchmark operator','local:executor')} as unknown as Run;
  const result=await freeze(fake);assert.equal(result.baselinePassed,false);assert.equal(acceptanceProblem(paths),null,'baseline ran named tests, not a harness exception');
  assert.equal((await runIndependentAcceptance(paths,1,1)).status,'❌');
  if(task==='add-validator'){
    writeFileSync(join(root,'src/validate.ts'),`export function validateCustomer(c: {email:string;phone:string}): string[] {const bad=[];const pieces=c.email.split('@');if(pieces.length!==2||!pieces[0]||!pieces[1].includes('.')||pieces[1].startsWith('.')||pieces[1].endsWith('.')||c.email.includes(' '))bad.push('email');if(!/^(?:\\+7\\d{10}|8\\d{10})$/.test(c.phone))bad.push('phone');return bad;}\n`);
    writeFileSync(join(root,'src/index.ts'),readFileSync(join(root,'src/index.ts'),'utf8')+"\nexport {validateCustomer} from './validate.ts';\n");
    writeFileSync(join(root,'test/new.test.ts'),"import test from 'node:test';import assert from 'node:assert/strict';import {validateCustomer} from '../src/index.ts';test('new behavior',()=>assert.deepEqual(validateCustomer({email:'a@b.c',phone:'81234567890'}),[]));\n");
    const repaired=await runIndependentAcceptance(paths,1,2);assert.equal(repaired.status,'✅',readFileSync(join(paths.dir,'state-evidence/acceptance-1-2.txt'),'utf8'));
    writeFileSync(join(root,'test/money.test.ts'),'// removed assertions\n');
    assert.equal((await runIndependentAcceptance(paths,1,3)).status,'❌');
  }
 });
}
