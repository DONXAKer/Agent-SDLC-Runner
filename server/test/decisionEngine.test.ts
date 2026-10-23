import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { DecisionEngine, DecisionError, decisionProvider, type DecisionContext } from '../src/exec/decisionEngine.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';

const schema={type:'object',properties:{decision:{type:'string',enum:['keep','change']}},required:['decision'],additionalProperties:false};
const context=():DecisionContext=>({revision:'revision-1',task:['Keep the public label and update the counter.'],constraints:{writable:['lib/counter.ts']},sourceVersions:{'lib/counter.ts':'source-1'}});
const turn=(text:string)=>({text,toolCalls:[],finishReason:'end_turn' as const,usage:emptyUsage()});

test('every repair is self-contained and journals exact requests without history',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const requests:ChatRequest[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(req){requests.push(req);assert.equal(req.messages.length,2);assert.ok(req.messages.every(m=>m.role==='system'||m.role==='user'));const packet=JSON.parse(req.messages[1]!.content);assert.deepEqual(packet.context.task,context().task);assert.equal(packet.question.source,'export const counter=1;');return turn(requests.length===1?'{broken':JSON.stringify({decision:'change'}));}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const result=await engine.decide({questionId:'counter',question:{source:'export const counter=1;'},instructions:'Return the requested decision',context:context(),schema,params:{max_tokens:1000},model:'fixture',signal:new AbortController().signal});
 assert.equal(result.attempts,2);assert.equal(result.kind,'proposed');
 const record=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8'));
 assert.equal(record.status,'proposed');assert.equal(record.entries.length,2);assert.match(record.entries[1].request.messages[1].content,/rejectedProposal/);
});

test('changed source revision and mandatory context overflow reject before mutation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let revision='revision-1',calls=0;
 const capture=()=>({...context(),revision});
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;revision='revision-2';return turn('{"decision":"change"}');}};
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:capture(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal};
 await assert.rejects(new DecisionEngine({provider,directory,capture,contextWindow:10000}).decide(input),(error:unknown)=>error instanceof DecisionError&&error.category==='stale');
 assert.equal(calls,1);
 await assert.rejects(new DecisionEngine({provider,directory,capture,contextWindow:100}).decide({...input,context:capture()}),(error:unknown)=>error instanceof DecisionError&&error.category==='context-required');assert.equal(calls,1);
});

test('three invalid decisions stop; semantic validators and cancellation remain authoritative',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let calls=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"change"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal};
 await assert.rejects(engine.decide({...input,validate(){throw Error('Observed source forbids this decision');}}),(e:unknown)=>e instanceof DecisionError&&e.category==='invalid-response');assert.equal(calls,3);
 const controller=new AbortController();controller.abort(Error('operator'));
 await assert.rejects(engine.decide({...input,signal:controller.signal}),/operator/);assert.equal(calls,3);
});

test('adapter rejects implicit history and forwards complete stage inputs with original schema name',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const provider:ChatProvider={name:'memoryless',async chat(req){assert.equal((req.params?.response_format as any).json_schema.name,'counter');return turn('{"decision":"keep"}');}};
 const adapter=decisionProvider(provider,{directory,capture:context,contextWindow:10000});
 const input:ChatRequest={model:'fixture',messages:[{role:'system',content:'Decide'},{role:'user',content:JSON.stringify({questionId:'counter',source:'counter=1'})}],tools:[],temperature:null,signal:new AbortController().signal,params:{max_tokens:100,response_format:{type:'json_schema',json_schema:{name:'counter',schema}}}};
 assert.equal(JSON.parse((await adapter.chat(input)).text).decision,'keep');
 await assert.rejects(adapter.chat({...input,messages:[...input.messages,{role:'assistant',content:'remember this',toolCalls:[]}]}),/history/);
});
