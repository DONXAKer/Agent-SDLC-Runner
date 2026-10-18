import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { guidedAcceptance } from '../bench/src/guidedAcceptance.ts';
import { requireTaskFiles } from '../bench/src/tasks.ts';

const root=resolve('.'); const args=process.argv.slice(2);
const option=(key,fallback)=>{const i=args.indexOf(key);if(i>=0 && !args[i+1])throw new Error(`Missing ${key}`);return i<0?fallback:args[i+1];};
const model=option('--model','ollama:qwen3.8-27b-iq4-gpumax');
const tasks=['add-validator','config-default','rename-field','migration-compat','bug-by-symptom','wrong-diagnosis','impossible-without-data','external-contract'];
tasks.forEach(task=>requireTaskFiles(join(root,'bench'),task));
const modes=['baseline','consumer-context','evidence-repair'];
const cases=[];
for(let repeat=1;repeat<=2;repeat++) for(const [index,task] of tasks.entries()) {
  const order=(repeat+index)%2?modes:[...modes].reverse();
  for(const mode of order) cases.push({task,repeat,mode});
}
// Fixed bounds and routes across all arms; no success label is inferred from a missing result.
const limits={stageMinutes:5,runMinutes:10,attempts:3};
const fingerprint=()=>{
  const hash=createHash('sha256');
  const visit=path=>{for(const entry of readdirSync(join(root,path),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(entry.isSymbolicLink() || ['node_modules','dist','.git','.runner'].includes(entry.name)) continue;
    const file=`${path}/${entry.name}`; if(entry.isDirectory()) visit(file); else hash.update(file).update(readFileSync(join(root,file)));
  }};
  for(const path of ['server/src','shared/src','bench/src','bench/fixtures','bench/checks','bench/expected','config']) visit(path);
  hash.update(readFileSync(join(root,'tools/compare-guided-improvements.mjs'))); return hash.digest('hex');
};
if(!args.includes('--run')) { console.log(JSON.stringify({model,cases,limits},null,2)); process.exit(0); }
const config=JSON.parse(readFileSync(join(root,'config/models.json'),'utf8'));
const definition=config.models.find(entry=>entry.id===model);
if(!definition || definition.provider!=='ollama') throw new Error('This local series requires an installed Ollama route');
const base=(process.env.OLLAMA_BASE_URL??config.providers.ollama.baseUrl).replace(/\/v1\/?$/u,'');
const endpoint=new URL(base); if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('Local endpoint required');
const get=async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Ollama HTTP ${r.status}`);return r.json();};
const environment={version:await get('/api/version'),model:(await get('/api/tags')).models.find(m=>m.name===definition.model || m.name===definition.model+':latest')};
if(!environment.model)throw new Error('Configured model not installed');
const id=`guided-improvements-${new Date().toISOString().replace(/\D/gu,'')}`;
const dir=join(root,'bench/results',id);mkdirSync(dir,{recursive:true});
const manifest={id,status:'running',model,environment,codeHash:fingerprint(),cases,limits,runs:[]};
const save=()=>writeFileSync(join(dir,'suite.json'),JSON.stringify(manifest,null,2));save(); console.log(`MANIFEST ${dir}`);
for(const [index,entry] of cases.entries()) {
  if(fingerprint()!==manifest.codeHash){manifest.status='source-changed';save();throw new Error('Code/config/fixtures changed during series');}
  const slug=`${id}-${index+1}`;
  const cli=['bench/src/cli.ts','--all','--model',model,'--task',entry.task,'--execution-mode','guided','--guided-engine-version','4','--preparation-version','3','--strict-questions',
    '--stage-timeout',String(limits.stageMinutes),'--run-timeout',String(limits.runMinutes),'--attempts',String(limits.attempts),'--slug',slug,
    ...(entry.mode==='baseline'?[]:[`--${entry.mode}`])];
  const run={...entry,slug,status:'running',args:cli,startedAt:new Date().toISOString()};manifest.runs.push(run);save();console.log(`START ${index+1}/${cases.length} ${entry.task} ${entry.mode}`);
  const fd=openSync(join(dir,`${slug}.log`),'w');
  try {run.exitCode=await new Promise((done,reject)=>{const child=spawn(process.execPath,cli,{cwd:root,windowsHide:true,stdio:['ignore',fd,fd]});child.once('error',reject);child.once('exit',done);});}
  catch(error){run.error=String(error);} finally{closeSync(fd);}
  const path=join(root,'bench/results',`${slug}.json`);
  const result=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  run.finishedAt=new Date().toISOString();run.seconds=(Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000;
  const options=result?.run?.guidedImprovements;
  const comparable=result?.run?.model===model && result?.guided?.engineVersion===4 &&
    Boolean(options?.consumerContext)===(entry.mode==='consumer-context') && Boolean(options?.evidenceRepair)===(entry.mode==='evidence-repair') && fingerprint()===manifest.codeHash;
  run.success=comparable && guidedAcceptance(result,'guided').success;
  run.status=result?(!comparable?'incomparable':run.success?'success':'failed'):'no-result';
  run.stopped=result?.driver?.stopped??null;run.workload=result?.guided?.workload??null;
  run.reachedChunk=result?.driver?.stages?.some(stage=>stage.stage==='chunk' && !stage.skipped)??false;
  run.execution=result?.execution??null;
  run.failure=result?.driver?.stages?.findLast(s=>!s.ok)?.failure??null;
  run.hidden=result?.hidden??null;run.honesty=result?.honesty??null;run.passport=result?.run??null;
  const independentCheck=result?.hidden && result.hidden.total>0 && result.hidden.skipped===0 && result.hidden.errorText===null;
  run.falseSuccess=result?.finalVerdict?.passed!==true ? null : result.honesty?.some(c=>c.ok===false) || (independentCheck ? result.hidden.fail>0 : null);
  save();console.log(`DONE ${index+1}/${cases.length}: ${run.status} ${run.stopped}`);
}
manifest.status='complete';save();
const rows=modes.map(mode=>{const runs=manifest.runs.filter(r=>r.mode===mode);return `| ${mode} | ${runs.filter(r=>r.success).length}/${runs.length} | ${runs.filter(r=>r.reachedChunk).length} | ${runs.filter(r=>r.falseSuccess===true).length}/${runs.filter(r=>r.falseSuccess!==null).length} | ${runs.filter(r=>r.status==='no-result').length} | ${(runs.reduce((n,r)=>n+r.seconds,0)/runs.length).toFixed(1)} |`;});
writeFileSync(join(dir,'report.md'),`# Guided improvements comparison\n\n| Mode | Acceptance | Reached Chunk | False success / evaluated green verdicts | Missing results | Mean seconds |\n|---|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nFixed eight tasks, two repeats, identical budgets. Small exploratory series, not statistical proof. Early-stage failures do not measure Chunk improvements. Missing results are infrastructure gaps, not model-quality evidence. Detailed execution metrics and usage by purpose are preserved per run in suite.json. Experiment flags remain off by default.\n`);
console.log(dir);
