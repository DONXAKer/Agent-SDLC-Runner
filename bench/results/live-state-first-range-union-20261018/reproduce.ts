// Task-specific, reproducible live experiment. No scripted model responses.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { loadConfig } from '../server/src/config/load.ts';
import { resolveProfile } from '../server/src/config/profiles.ts';
import type { ProjectConfig } from '../server/src/config/schema.ts';
import { ApprovalGate } from '../server/src/approval/gate.ts';
import { AskGate } from '../server/src/approval/askGate.ts';
import { Run } from '../server/src/run/Run.ts';
import { DECISION } from '../server/src/artifacts/artifact.ts';
import { resolvedRequirementsHash } from '../server/src/artifacts/resolvedRequirements.ts';
import { runBench } from '../bench/src/driver.ts';
import { sourceFingerprint } from '../bench/src/taskLoopPilot.ts';

const root = resolve('.');
const out = resolve('bench/results/live-state-first-range-union-20261018');
const projectRoot = resolve('.tmp/state-first-live-range-project');
const suite = join(out, 'independent-suite');
if (existsSync(join(out, 'passport.json')) || existsSync(projectRoot)) throw new Error('Fresh output/workspace required');
mkdirSync(out, {recursive:true}); mkdirSync(suite, {recursive:true});
process.env.SDLC_STATE_DIR = resolve('.tmp/state-first-live-runtime');
process.env.LMSTUDIO_BASE_URL = 'http://localhost:1434/v1';
const json = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data,null,2)+'\n');
cpSync('bench/fixtures/evidence-range-union',projectRoot,{recursive:true});
// Task and simulated human answers are experiment inputs, not files in the candidate.
execFileSync('git',['init','-q','-b','main'],{cwd:projectRoot});
const git = (...args: string[]) => execFileSync('git',args,{cwd:projectRoot,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'State-first pilot',GIT_AUTHOR_EMAIL:'pilot@example.invalid',GIT_COMMITTER_NAME:'State-first pilot',GIT_COMMITTER_EMAIL:'pilot@example.invalid'}});
git('add','-A'); git('commit','-qm','Initial range library'); git('switch','-qc','sdlc/range-union');
const config = loadConfig();
config.runner.operator = 'Codex — запуск по поручению пользователя';
config.runner.limits = {...config.runner.limits,maxIterationsPerStage:30,chatTimeoutMs:180000,gateTimeoutMs:60000};
config.runner.reviewModel = undefined;
const stages = Object.fromEntries(STAGE_ORDER.map(stage=>[stage,stage==='verify'?'lmstudio:qwen3-8b-exploreindex':'lmstudio:gpt-oss-20b-f16'])) as ProjectConfig['profiles'][string]['stages'];
const project: ProjectConfig = {name:'state-first live range union',projectRoot,activeProfile:'live',maxBudgetUsd:1,profiles:{live:{label:'Live state-first: GPT-OSS + Qwen review',stages}}};
const profile = resolveProfile(project,config.models,'live');
let gate: ApprovalGate;
gate = new ApprovalGate({onPending:p=>{
  appendFileSync(join(out,'operator.ndjson'),JSON.stringify({kind:'tool_approval',at:new Date().toISOString(),request:p})+'\n');
  setImmediate(()=>gate.resolve(p.runId,p.requestId,{allowed:true,updatedInput:null,by:'operator'}));
},onResolved:()=>{}});
const askGate = new AskGate({onPending:p=>{
  appendFileSync(join(out,'operator.ndjson'),JSON.stringify({kind:'unanswered_question',request:p})+'\n');
  // No invented answers: the deadline will stop a task requiring missing facts.
},onAnswered:()=>{}});
const run = new Run({config,project,profile,slug:'range-union',gate,askGate,emit:e=>{
  appendFileSync(join(out,'events.ndjson'),JSON.stringify(e)+'\n');
  if (['stage_done','warning','error'].includes(e.type)) console.log(JSON.stringify(e));
}});
mkdirSync(join(projectRoot,'.sdlc'),{recursive:true});
writeFileSync(join(projectRoot,'.sdlc/gates.md'),'# Набор гейтов\n\n## Набор\n\n| Гейт | Вкл | Где отчитывается | Чем реализован |\n|---|---|---|---|\n| Сборка | да — минимум | этап 6 | `node scripts/build.mjs` |\n| Тесты | да — минимум | этап 6 | `node --test "test/*.test.mjs"` |\n| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки diff с files_to_touch |\n| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |\n| Ревью независимым агентом | да — минимум | этап 6 | независимый квалифицированный агент |\n');
const clauses = [
  ['claim-1','Export mergeRanges: sort and merge overlapping/touching finite numeric [start,end] pairs; [] returns [].','Named independent behavior check'],
  ['claim-2','Do not mutate input or share output pair arrays with input.','Frozen input and alias tests'],
  ['claim-3','Invalid pairs, reversed endpoints and nonfinite numbers throw TypeError.','Invalid-input table'],
  ['claim-4','Preserve existing exports and tests; add an executable test under test/. Only src/ and test/ may change; existing tests are protected.','API, protected-file hash, new test and scope checks'],
];
const task = readFileSync(join(projectRoot,'task.md'),'utf8');
const intent = '# Задача: range union\n\n- **Контур:** мелкий\n- **Ветка витка:** sdlc/range-union\n\n## Задача от человека\n\n'+task+'\n\n## Приёмка\n\n| id | Пункт | Как проверить |\n|---|---|---|\n'+clauses.map(c=>'| '+c.join(' | ')+' |').join('\n')+'\n';
run.enableStateFirst();
writeFileSync(run.paths.intent,intent);
writeFileSync(run.paths.plan,'# План: range union\n\n- **Требования (SHA-256):** '+resolvedRequirementsHash(intent,'')+'\n- **Одобрение:** ‹подпись и дата›\n\n## files_to_touch\n\n| Путь | Что делаем |\n|---|---|\n| src/ranges.mjs | Add mergeRanges, preserve protocolVersion |\n| test/merge-ranges.test.mjs | New executable tests; leave existing.test.mjs unchanged |\n\n## Шаги\n\n1. Read public module and existing test.\n2. Implement the contract in the public module, add a new test.\n3. Fill chunk journal using the methodology template. Runtime executes checks.\n');
run.recordDecision({artifact:'plan',label:DECISION.approval,granted:true,note:'Оператор подготовил контракт и план до реализации; измеряются Chunk и Verify, подготовка v1 не измеряется.'});
const baselineProtected = readFileSync(join(projectRoot,'test/existing.test.mjs'),'utf8');
writeFileSync(join(suite,'contract.test.mjs'),`import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=process.env.SDLC_CANDIDATE_ROOT;
const load=()=>import(pathToFileURL(root+'/src/ranges.mjs').href);
test('sorted merged ranges',async()=>{const {mergeRanges:f}=await load();assert.equal(typeof f,'function');for(const [input,want] of [[[],[]],[[[5,8],[1,3],[3,5]],[[1,8]]],[[[-4,-2],[-1,0],[-3,-1]], [[-4,0]]],[[[2,2],[1,9],[1,3]],[[1,9]]],[[[8,9],[1,2],[4,6]],[[1,2],[4,6],[8,9]]],[[[0.25,0.75],[0.75,1.5]],[[0.25,1.5]]]])assert.deepEqual(f(input),want);});
test('input and output independence',async()=>{const {mergeRanges:f}=await load();assert.equal(typeof f,'function');const input=Object.freeze([Object.freeze([3,4]),Object.freeze([1,2])]);const out=f(input);assert.deepEqual(input,[[3,4],[1,2]]);assert.deepEqual(out,[[1,2],[3,4]]);assert.notEqual(out,input);for(const pair of out)for(const original of input)assert.notEqual(pair,original);out[0][0]=99;assert.deepEqual(input,[[3,4],[1,2]]);});
test('invalid values throw TypeError',async()=>{const {mergeRanges:f}=await load();assert.equal(typeof f,'function');for(const value of [null,{},'bad',[null],[[1]],[[1,2,3]],[[3,2]],[[NaN,2]],[[1,Infinity]],[[1,-Infinity]],[['1',2]],[[true,2]],[[undefined,2]]])assert.throws(()=>f(value),TypeError);});
test('preserve API and add tests',async()=>{const m=await load();assert.equal(m.protocolVersion,1);assert.equal(fs.readFileSync(root+'/test/existing.test.mjs','utf8'),${JSON.stringify(baselineProtected)});assert.ok(fs.existsSync(root+'/test/merge-ranges.test.mjs'),'new planned test exists');assert.match(fs.readFileSync(root+'/test/merge-ranges.test.mjs','utf8'),/node:test/);});
`);
const startedAt = new Date().toISOString();
json(join(out,'passport.json'),{startedAt,sourceHash:sourceFingerprint(root),revision:git('rev-parse','HEAD').trim(),projectRoot,profile,task,claims:clauses,scope:'Operator-prepared v1 contract; real model Chunk and Verify; one implementation attempt; no scripted replies',limitations:['Finite named tests do not prove all inputs.','Qwen 8B review reliability is not established by this run.','Approval automation accepts requests within runtime policy; user did not manually click each approval.']});
writeFileSync(join(out,'reproduce.ts'),readFileSync(import.meta.filename,'utf8'));
const results: Record<string,unknown> = {};
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  const blockedBeforeSuite = run.blockers('chunk');
  json(join(out,'before-suite.json'),blockedBeforeSuite);
  results.registration = await run.registerIndependentAcceptance({sourceDir:suite,image:'node:20-alpine',author:{kind:'model',id:'openai:codex-assistant-session'},qualification:'Prepared by the supervising assistant from the pre-existing task before candidate code; reviewed explicit expected outputs and red baseline. Reliability limited to declared cases.',checks:clauses.map((c,i)=>({claimId:c[0],file:'contract.test.mjs',name:['sorted merged ranges','input and output independence','invalid values throw TypeError','preserve API and add tests'][i]})),limitations:'Node built-in modules, finite input classes; no proof of arbitrary numeric behavior'});
  json(join(out,'registration.json'),results.registration);
  console.log('Frozen independent tests; baseline recorded. Starting live Chunk.');
  heartbeat=setInterval(()=>json(join(out,'status.json'),{at:new Date().toISOString(),stage:run.canonicalState()?.stage,status:run.status}),5000);
  const args={run,stageTimeoutMs:600000,runTimeoutMs:900000,attempts:1,preparationVersion:1 as const,onDecision:console.log};
  results.chunk=await runBench({...args,startStage:'chunk',stopAfterStage:'chunk'});
  json(join(out,'chunk.json'),results.chunk);
  console.log('Chunk finished; starting independent review with Qwen3 8B.');
  // Models run sequentially to fit shared local memory.
  execFileSync('lms',['unload','gpt-oss-20b'],{stdio:'pipe',windowsHide:true});
  results.verify=await runBench({...args,startStage:'verify',stopAfterVerify:true});
  json(join(out,'verify.json'),results.verify);
  results.verdict=run.lastVerdict;
  results.gates=run.gateResults;
  results.state=run.canonicalState();
  json(join(out,'state.json'),results.state);
  json(join(out,'result.json'),{startedAt,finishedAt:new Date().toISOString(),...results});
  cpSync(run.paths.dir,join(out,'artifacts'),{recursive:true});
  cpSync(join(projectRoot,'src'),join(out,'candidate/src'),{recursive:true});
  cpSync(join(projectRoot,'test'),join(out,'candidate/test'),{recursive:true});
  writeFileSync(join(out,'tracked.patch'),git('diff','HEAD','--'));
  console.log(JSON.stringify({output:out,verdict:results.verdict,gates:results.gates},null,2));
} catch(error) {
  json(join(out,'error.json'),{error:String(error),stack:(error as Error).stack,results});
  throw error;
} finally {if(heartbeat)clearInterval(heartbeat);await run.dispose();}
