import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { RunFlowRecorder } from '../src/run/runFlow.ts';
import { ExecutionObserver } from '../src/exec/executionObserver.ts';
import { executionSummary } from '../src/run/executionSummary.ts';
import { evidenceRepairTargets } from '../src/exec/repairDiagnosis.ts';
import { buildGuidedWorkingContext } from '../src/exec/guidedWorkingContext.ts';

test('trace correlates delayed responses, pages and accounts only canonical usage', async t => {
  const root=mkdtempSync(join(tmpdir(),'execution-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const recorder=new RunFlowRecorder(new WitokPaths(root,'task'),'run'); recorder.beginStage('chunk',{});
  const observer=new ExecutionObserver(event=>recorder.record('execution_operation',event)); observer.itemId='unit';
  const end=observer.start('proposal');
  recorder.record('model_request',{requestId:'req',model:'local'}); end('passed');
  recorder.record('model_http',{requestId:'req',usage:emptyUsage()});
  recorder.record('model_work',{usage:{...emptyUsage(),inputTokens:12,costUsd:null},work:{purpose:'proposal',requests:1,operationId:observer.lastCompletedId},currency:'USD',durationMs:20});
  await observer.run('check',async()=>({passed:false,result:'known failure'}));
  await observer.run('check',async()=>({passed:false,result:'known failure'}));
  await observer.run('check',async()=>({passed:true,result:'passed'}));
  const all=recorder.report().entries;
  assert.equal(all.find(e=>e.kind==='model_request')?.operationId,all.find(e=>e.kind==='model_http')?.operationId);
  assert.equal(all.find(e=>e.kind==='model_work')?.operationId,all.find(e=>e.kind==='model_http')?.operationId);
  assert.deepEqual(recorder.page(0,2).entries,all.slice(0,2)); assert.equal(recorder.page(0,2).hasMore,true);
  const summary=executionSummary([...all,...all]);
  assert.equal(summary.byPurpose.proposal?.requests,1); assert.equal(summary.byPurpose.proposal?.inputTokens,12);
  assert.equal(summary.byPurpose.proposal?.cost,null); assert.equal(summary.repeatedFailures,1);
  assert.equal(summary.complete,true);
  assert.deepEqual(summary.checks,{passed:1,failed:2,firstAttemptPassed:0,itemsChecked:1});
});

test('restart marks open work interrupted and recorder failure is visible without throwing', t => {
  const root=mkdtempSync(join(tmpdir(),'execution-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=new WitokPaths(root,'task'); const recorder=new RunFlowRecorder(paths,'run'); recorder.beginStage('chunk',{});
  new ExecutionObserver(e=>recorder.record('execution_operation',e)).start('proposal');
  const resumed=new RunFlowRecorder(paths,'run'); assert.equal(resumed.page().summary.interrupted,1); assert.equal(resumed.page().summary.active.length,0);
  const broken=new RunFlowRecorder(paths,'blocked'); mkdirSync(broken.dir,{recursive:true}); mkdirSync(join(broken.dir,'trace.ndjson'));
  assert.doesNotThrow(()=>broken.record('anything',{})); assert.equal(broken.page().summary.complete,false);
  assert.ok(broken.page().summary.limitations.some(x=>x.includes('ошибки журнала')));
});

test('late model response retains the requesting stage after a stage transition', t => {
  const root=mkdtempSync(join(tmpdir(),'execution-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const recorder=new RunFlowRecorder(new WitokPaths(root,'task'),'run'); recorder.beginStage('chunk',{});
  recorder.record('model_request',{requestId:'delayed'});
  recorder.beginStage('verify',{});
  recorder.record('model_http',{requestId:'delayed'});
  const entries=recorder.report().entries;
  const request=entries.find(e=>e.kind==='model_request')!;
  const response=entries.find(e=>e.kind==='model_http')!;
  assert.equal(response.stage,'chunk'); assert.equal(response.invocation,request.invocation);
});

test('consumer context uses real imports, preserves read boundaries and detects stale source', t => {
  const root=mkdtempSync(join(tmpdir(),'context-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'core.ts'),'export function compute() { return 1; }');
  writeFileSync(join(root,'caller.ts'),"import {compute} from './core.ts'; export function invoke() { return compute(); }");
  writeFileSync(join(root,'unseen.ts'),"const core = require('./core.ts');");
  writeFileSync(join(root,'comment.ts'),"// import {compute} from './core.ts';\nexport const x = 1;");
  const args=['core.ts']; const observed=new Set(['caller.ts','comment.ts']);
  const normal=buildGuidedWorkingContext(root,args,[],observed);
  const improved=buildGuidedWorkingContext(root,args,[],observed,'',14000,true);
  assert.equal(normal.fragments.some(f=>f.role==='consumer'),false);
  assert.ok(improved.fragments.some(f=>f.role==='consumer' && f.path==='caller.ts'));
  assert.equal(improved.fragments.some(f=>f.path==='unseen.ts' || f.path==='comment.ts'),false);
  assert.ok(improved.missing.some(f=>f.path==='unseen.ts'));
  assert.equal(buildGuidedWorkingContext(root,args,[],observed,'',20,true).partial,true);
});

test('evidence repair accepts anchored diagnostics, protects tests and refuses unknowns', () => {
  const allowed=['lib/value.ts','test/value.test.ts','other/value.ts'];
  assert.deepEqual(evidenceRepairTargets('lib/value.ts(2,4): error TS2322: wrong type',allowed),['lib/value.ts']);
  assert.deepEqual(evidenceRepairTargets('value.ts(2,4): error TS2322: wrong type',allowed),[]);
  assert.deepEqual(evidenceRepairTargets('test/value.test.ts(2,4): error TS2322: wrong type',allowed),[]);
  for (const path of ['__tests__/value.ts','specs/value.ts','spec/value.ts','nested\\__tests__\\value.ts']) {
    assert.deepEqual(evidenceRepairTargets(`${path}(2,4): error TS2322: wrong type`,[path]),[]);
    assert.deepEqual(evidenceRepairTargets('not ok 1 - value\n actual: 1\n expected: 2',[path]),[]);
  }
  assert.deepEqual(evidenceRepairTargets('service unreachable',allowed),[]);
  assert.deepEqual(evidenceRepairTargets('not ok 1 - value\n actual: 1\n expected: 2',allowed),['lib/value.ts','other/value.ts']);
});
