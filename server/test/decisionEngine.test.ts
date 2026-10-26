import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { DecisionEngine, DecisionError, decisionProvider, type DecisionContext } from '../src/exec/decisionEngine.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { WorkBudgetExhausted } from '../src/exec/workBudget.ts';
import { estimateMessageTokens } from '../src/exec/contextBudget.ts';

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

test('the same invalid decision stops on its second rejection; cancellation remains authoritative',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let calls=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"change"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal};
 await assert.rejects(engine.decide({...input,validate(){throw Error('Observed source forbids this decision');}}),(e:unknown)=>e instanceof DecisionError&&e.category==='invalid-response'&&/rejected twice with the same proposalHash/.test(e.message));assert.equal(calls,2);
 const controller=new AbortController();controller.abort(Error('operator'));
 await assert.rejects(engine.decide({...input,signal:controller.signal}),/operator/);assert.equal(calls,2);
});

test('adapter rejects implicit history and forwards complete stage inputs with original schema name',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const provider:ChatProvider={name:'memoryless',async chat(req){assert.equal((req.params?.response_format as any).json_schema.name,'counter');return turn('{"decision":"keep"}');}};
 const adapter=decisionProvider(provider,{directory,capture:context,contextWindow:10000});
 const input:ChatRequest={model:'fixture',messages:[{role:'system',content:'Decide'},{role:'user',content:JSON.stringify({questionId:'counter',source:'counter=1'})}],tools:[],temperature:null,signal:new AbortController().signal,params:{max_tokens:100,response_format:{type:'json_schema',json_schema:{name:'counter',schema}}}};
 assert.equal(JSON.parse((await adapter.chat(input)).text).decision,'keep');
 await assert.rejects(adapter.chat({...input,messages:[...input.messages,{role:'assistant',content:'remember this',toolCalls:[]}]}),/history/);
});

test('semantic rejection is repaired from the rejected proposal and exact diagnostics',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const packets:any[]=[];const validations:unknown[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(req){packets.push(JSON.parse(req.messages[1]!.content));return turn(JSON.stringify({decision:packets.length===1?'change':'keep'}));}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000,onValidation:result=>validations.push(result)});
 const result=await engine.decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal,
  validate(value:any){if(value.decision!=='keep')throw Error('Citation does not address the question');return value;}});
 assert.equal(result.attempts,2);assert.equal(packets[1].recovery.rejectedProposal,'{"decision":"change"}');assert.match(packets[1].recovery.diagnostics,/Citation does not address/);
 assert.deepEqual(validations,[{questionId:'counter',accepted:false,reason:'Error: Citation does not address the question'}]);
});

test('a truncated structured decision gets one bounded completion retry',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const limits:number[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(req){limits.push(Number(req.params?.max_tokens));return limits.length===1?{...turn(''),finishReason:'max_tokens'}:turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const result=await engine.decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},maxTokensLimit:200,model:'fixture',signal:new AbortController().signal});
 assert.equal(result.attempts,2);assert.deepEqual(limits,[100,200]);
 const record=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8'));
 assert.equal(record.entries.length,2);assert.equal(record.entries[0].request.params.max_tokens,100);assert.equal(record.entries[1].request.params.max_tokens,200);
});

test('requestLimit caps semantic repairs and onRequest reports every real provider call',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let calls=0,observed=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"change"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal,
  requestLimit:1,onRequest:()=>observed++,validate(){throw Error('Rejected citation');}};
 await assert.rejects(engine.decide(input),(error:unknown)=>error instanceof DecisionError&&error.category==='invalid-response'&&/after 1 attempts/.test(error.message));
 assert.equal(calls,1);assert.equal(observed,1);
 await assert.rejects(engine.decide({...input,requestLimit:0}),(error:unknown)=>error instanceof DecisionError&&error.category==='budget');
 assert.equal(calls,1);assert.equal(observed,1);
});

test('a request rejected before provider acceptance is not counted as model work',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let observed=0;
 const provider:ChatProvider={name:'memoryless',async chat(){throw new WorkBudgetExhausted('requests','work','limit reached');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 await assert.rejects(engine.decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal,onRequest:()=>observed++}),WorkBudgetExhausted);
 assert.equal(observed,0);
 const record=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8'));
 assert.equal(record.entries.length,1);assert.equal(record.entries[0].providerAccepted,undefined);
});

test('decision envelope clamps completion to the remaining window without raising a smaller cap',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const limits:number[]=[],remaining:number[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(req){limits.push(Number(req.params?.max_tokens));remaining.push(2000-estimateMessageTokens(req.messages)-512);return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:2000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,model:'fixture',signal:new AbortController().signal};
 await engine.decide({...input,params:{max_tokens:2166}});
 await engine.decide({...input,params:{max_tokens:100}});
 assert.equal(limits[0],remaining[0]);assert.equal(limits[1],100);assert.ok(remaining[1]!>100);
});

test('provider acceptance and the response are journaled before post-response cancellation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const controller=new AbortController();
 const provider:ChatProvider={name:'memoryless',async chat(req){req.onRequest?.();controller.abort(Error('operator'));return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 await assert.rejects(engine.decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:controller.signal}),/operator/);
 const record=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8'));
 assert.equal(record.status,'accepted');assert.equal(record.entries[0].providerAccepted,true);assert.equal(record.entries[0].answer,'{"decision":"keep"}');
});

test('canonical packets and request hashes ignore object key order without sorting arrays',async t=>{
 const packets:string[]=[],hashes:string[]=[];
 const questions=[{z:'last',a:{z:1,a:2},sequence:['second','first']},{sequence:['second','first'],a:{a:2,z:1},z:'last'}];
 const schemas=[schema,{additionalProperties:false,required:['decision'],properties:{decision:{enum:['keep','change'],type:'string'}},type:'object'}];
 for(let index=0;index<2;index++){
  const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const provider:ChatProvider={name:'memoryless',async chat(req){packets.push(req.messages[1]!.content);return turn('{"decision":"keep"}');}};
  const current=index===0?context():{sourceVersions:{'lib/counter.ts':'source-1'},constraints:{writable:['lib/counter.ts']},task:['Keep the public label and update the counter.'],revision:'revision-1'};
  await new DecisionEngine({provider,directory,capture:()=>current,contextWindow:10000}).decide({questionId:'counter',question:questions[index],instructions:'Decide',context:current,schema:schemas[index]!,params:{optional:undefined,max_tokens:100},model:'fixture',signal:new AbortController().signal});
  const record=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]!),'utf8'));hashes.push(record.requestHash);
 }
 assert.equal(packets[0],packets[1]);assert.equal(hashes[0],hashes[1]);assert.doesNotMatch(packets[0]!,/decisionId|startedAt|"attempt"/);
 assert.deepEqual(JSON.parse(packets[0]!).question.sequence,['second','first']);
});

test('guided decoding defaults are explicit, overridable, and journaled exactly',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const requests:ChatRequest[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(req){requests.push(req);return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,model:'fixture',signal:new AbortController().signal};
 await engine.decide({...input,params:{max_tokens:100}});
 await engine.decide({...input,params:{max_tokens:100,temperature:0.4,seed:17,top_p:0.8}});
 assert.equal(requests[0]!.temperature,0);assert.equal(requests[0]!.params?.temperature,0);assert.equal(requests[0]!.params?.seed,0);
 assert.equal(requests[1]!.temperature,0.4);assert.equal(requests[1]!.params?.temperature,0.4);assert.equal(requests[1]!.params?.seed,17);
 const records=readdirSync(directory).map(name=>JSON.parse(readFileSync(join(directory,name),'utf8')));
 const defaults=records.find(record=>record.params.seed===0),overridden=records.find(record=>record.params.seed===17);
 assert.deepEqual(defaults.entries[0].request.params,requests[0]!.params);assert.deepEqual(overridden.entries[0].request.params,requests[1]!.params);
});

test('local structured decisions suppress reasoning by default and carry the schema only on the wire',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const requests:ChatRequest[]=[];
 const provider:ChatProvider={name:'ollama',async chat(req){requests.push(req);return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,model:'fixture',signal:new AbortController().signal};
 await engine.decide({...input,params:{max_tokens:100}});
 await engine.decide({...input,params:{max_tokens:100,reasoning_effort:'low'}});
 for(const [index,request] of requests.entries()){
  const packet=JSON.parse(request.messages[1]!.content);
  assert.equal(packet.responseSchema,undefined);
  assert.equal((request.params?.response_format as any).json_schema.schema,schema);
  assert.equal(request.params?.reasoning_effort,index===0?'none':'low');
 }
});

test('a degenerate completion reserve rejects before provider work',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let calls=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:1300});
 await assert.rejects(engine.decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:null,model:'fixture',signal:new AbortController().signal}),
  (error:unknown)=>error instanceof DecisionError&&error.category==='context-required');
 assert.equal(calls,0);
});

test('an accepted decision replays without provider work and journals a synthetic replay',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let calls=0,observed=0;const validations:unknown[]=[];
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal,
  onRequest:()=>observed++,validate(value:any){validations.push(value.decision);return value;}};
 const proposed=await engine.decide(input);const replayed=await engine.decide({...input,requestLimit:0});
 assert.equal(proposed.kind,'proposed');assert.equal(replayed.kind,'replayed');assert.equal(replayed.attempts,0);assert.deepEqual(replayed.value,proposed.value);
 assert.equal(calls,1);assert.equal(observed,1);assert.deepEqual(validations,['keep','keep']);assert.deepEqual(replayed.usage,emptyUsage());assert.deepEqual(replayed.turn.toolCalls,[]);
 const records=readdirSync(directory).map(name=>JSON.parse(readFileSync(join(directory,name),'utf8')));
 const original=records.find(record=>record.decisionId===proposed.decisionId),replay=records.find(record=>record.decisionId===replayed.decisionId);
 assert.equal(replay.status,'replayed');assert.equal(replay.requestHash,original.requestHash);assert.equal(replay.replayOf,proposed.decisionId);assert.deepEqual(replay.entries,[]);assert.deepEqual(replay.extra.value,{decision:'keep'});
});

test('changed source revision, schema, or params cannot reuse an accepted replay',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let revision='revision-1',calls=0;const capture=()=>({...context(),revision});
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture,contextWindow:10000});
 const input=()=>({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:capture(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal});
 assert.equal((await engine.decide(input())).kind,'proposed');
 revision='revision-2';assert.equal((await engine.decide(input())).kind,'proposed');
 assert.equal((await engine.decide({...input(),schema:{...schema,description:'Different response contract'}})).kind,'proposed');
 assert.equal((await engine.decide({...input(),params:{max_tokens:101}})).kind,'proposed');assert.equal(calls,4);
 await assert.rejects(engine.decide({...input(),context:context()}),(error:unknown)=>error instanceof DecisionError&&error.category==='stale');assert.equal(calls,4);
});

test('a replay value that fails current semantic validation is rebuilt by the provider',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let calls=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn(calls===1?'{"decision":"keep"}':'{"decision":"change"}');}};
 await new DecisionEngine({provider,directory,capture:context,contextWindow:10000}).decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal});
 const result=await new DecisionEngine({provider,directory,capture:context,contextWindow:10000}).decide({questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal,
  validate(value:any){if(value.decision==='keep')throw Error('Current source forbids replay');return value;}});
 assert.equal(calls,2);assert.equal(result.kind,'proposed');assert.equal(result.attempts,1);assert.deepEqual(result.value,{decision:'change'});
});

test('terminal unsupported and human-required decisions are not resampled',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let calls=0;
 const provider:ChatProvider={name:'memoryless',async chat(){calls++;return turn('{"decision":"keep"}');}};
 const engine=new DecisionEngine({provider,directory,capture:context,contextWindow:10000});
 const input={questionId:'counter',question:{source:'counter=1'},instructions:'Decide',context:context(),schema,params:{max_tokens:100},model:'fixture',signal:new AbortController().signal};
 for(const category of ['unsupported','human-required'] as const){
  await assert.rejects(engine.decide({...input,validate(){throw new DecisionError(category,'Input cannot be compiled','validator');}}),
   (error:unknown)=>error instanceof DecisionError&&error.category===category);
 }
 assert.equal(calls,2);
 const records=readdirSync(directory).map(name=>JSON.parse(readFileSync(join(directory,name),'utf8')));
 assert.deepEqual(records.map(record=>record.status).sort(),['human-required','unsupported']);
});
