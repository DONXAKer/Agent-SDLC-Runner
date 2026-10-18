import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { emptyUsage } from '@sdlc-runner/shared';
import type { ExecutionOperation } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedExecutor } from '../src/exec/GuidedExecutor.ts';
import { initGuided } from '../src/run/guidedState.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

for (const scenario of ['evidence','baseline','unknown','environment','cancel'] as const) test(`repair execution: ${scenario}`, async t=>{
  const root=mkdtempSync(join(tmpdir(),'evidence-repair-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=new WitokPaths(root,'task'); initGuided(paths,'local',4);
  const before='function value() { return 0; }'; writeFileSync(join(root,'logic.ts'),before);
  const controller=new AbortController(); let proposals=0; let diagnoses=0;
  const events:ExecutionOperation[]=[];
  const provider:ChatProvider={name:'fixture',chat:async request=>{
    const input=JSON.parse(request.messages[1]!.content);
    if(input.output){ diagnoses++; return {text:'invalid diagnosis',toolCalls:[],finishReason:'end_turn',usage:emptyUsage()}; }
    proposals++;
    return {text:JSON.stringify({action:'patch',prediction:'value returns two',ops:[{op:'replace_body',...(input.targetSymbol?{}:{symbol:'value'}),body:`return ${proposals};`}]}),toolCalls:[],finishReason:'end_turn',usage:emptyUsage()};
  }};
  const hooks:ExecHooks={onText(){},onThinking(){},onWarn(){},onUsage(){},onFriction(){},onToolResult(){},onRecord:()=>'',onAskHuman:async()=>({}),
    onToolRequest:async()=>({allowed:true,reason:'fixture',by:'policy',updatedInput:null}),onExecution:event=>events.push(event)};
  const req:ExecRequest={cwd:root,model:'fixture',guidedEngineVersion:4,maxTurns:10,maxBudgetUsd:null,allowedTools:['Read','Write','Edit'],
    readOnlyDirs:[],subagents:[],mcp:null,signal:controller.signal,prompt:{system:'',user:'',guidedProtocol:true} as ExecRequest['prompt'],finishGuard:null,salvageFromText:null};
  const result=await new GuidedExecutor({paths,provider,contextWindow:32768,evidenceRepair:scenario!=='baseline',
    items:[{id:'unit',files:['logic.ts'],claims:['r1'],title:'value two',prediction:'two',checks:['test'],dependsOn:[],status:'pending',attempts:0,repartitioned:false}],
    inputRevision:()=> 'fixed',requirements:'value returns two',originalRequests:['value must return two'],sources:'explicit request',
    check:async()=>{
      if(scenario==='cancel') controller.abort();
      const passed=runInNewContext(readFileSync(join(root,'logic.ts'),'utf8')+'\nvalue()')===2;
      return {passed,environment:scenario==='environment',result:scenario==='unknown'?'unstructured failure':passed?'passed':'not ok 1 - value\n actual: 1\n expected: 2'};
    },
  }).run(req,hooks);
  assert.equal(result.ok,scenario==='evidence',result.note);
  assert.equal(diagnoses,scenario==='baseline'?1:0);
  assert.equal(proposals,scenario==='evidence'?2:1);
  assert.equal(events.filter(e=>e.phase==='started').length,events.filter(e=>e.phase==='finished').length);
  if(scenario==='evidence') assert.ok(events.some(e=>e.kind==='repair'));
  else { assert.equal(readFileSync(join(root,'logic.ts'),'utf8'),before); assert.ok(events.some(e=>e.kind==='rollback')); }
  if(scenario==='unknown') assert.equal(result.failure?.retryStage,'explore');
});
