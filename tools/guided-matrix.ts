import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,appendFileSync,symlinkSync,openSync,closeSync,rmSync,lstatSync,linkSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname,relative,sep} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {INPUTS,inventory,stableDigest,readJson,saveJson,assertEngineLog,collectComparisonEvidence} from '../bench/src/harnessComparison.ts';
import {assessGuidedValidation,currentGuidedResult} from '../bench/src/guidedValidation.ts';
import {loadConfig} from '../server/src/config/load.ts';
import {pinNodeImage} from '../server/src/run/isolatedNode.ts';
import type {BenchResult} from '../bench/src/result.ts';
import type {PreflightReport} from '../bench/src/preflight.ts';
import {checkPlacement,placementPolicy,qualifyModel,type Qualification} from '../bench/src/modelQualification.ts';

const root=resolve(import.meta.dirname,'..');
const specSchema=z.object({modelConfig:z.string(),models:z.array(z.string()).min(1).max(6),tasks:z.array(z.string()).min(1).max(5),acceptanceImage:z.string(),
 guidedEngineVersion:z.union([z.literal(4),z.literal(5)]).default(4),repetitions:z.number().int().min(1).max(3).default(1),
 profileOverrides:z.record(z.string(),z.object({placement:placementPolicy.default('gpu-only'),params:z.record(z.string(),z.unknown()).optional()})).default({}),
 limits:z.object({stageMinutes:z.number().positive(),runMinutes:z.number().positive(),attempts:z.number().int().positive(),gpuWaitMinutes:z.number().positive(),suiteHours:z.number().positive()}),
 engine:z.object({host:z.string().url(),gpuFreeMiB:z.array(z.number()).length(2),gpuUtilMax:z.array(z.number()).length(2)})});
type Spec=z.infer<typeof specSchema>;
type Profile={id:string;provider:string;model:string;contextWindow?:number;params?:Record<string,unknown>;placement?:'gpu-only'|'hybrid'};
type Cell={id:string;model:string;task:string;status:string;slug?:string;startedAt?:string;finishedAt?:string;pid?:number;elapsedMs?:number;outcome?:ReturnType<typeof assessGuidedValidation>;evidence?:ReturnType<typeof collectComparisonEvidence>;error?:string;layout?:unknown;invocationBudgetMs?:number};
type Matrix={version:1;status:string;preparedAt:string;spec:Spec;specHash:string;acceptanceImage:string;profiles:Profile[];cells:Cell[];inputs:Record<string,string>;common:Record<string,string>;coordinatorHash:string;nodeVersion:string;modelDigests?:Record<string,string>;qualifications?:Record<string,Qualification>;engineVersion?:unknown;startedAt?:string;finishedAt?:string;error?:string;active?:string};
const coordinatorHash=()=>stableDigest(inventory(root,['tools/guided-matrix.ts','bench/src/harnessComparison.ts','bench/src/guidedValidation.ts','tools/guided-suite-success.ts']));
function emit(dir:string,m:Matrix){
 saveJson(join(dir,'manifest.json'),m);
 const clean=(x:unknown)=>String(x??'неизвестно').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
 writeFileSync(join(dir,'summary.ru.md'),`# Полный guided-цикл с независимой приёмкой\n\nСтатус: **${m.status}**. Завершено: ${m.cells.filter(c=>c.status==='complete').length}/${m.cells.length}. Успех: ${m.cells.filter(c=>c.outcome?.success).length}.\n\n| Модель | Задача | Статус | Успех | Причина |\n|---|---|---|---|---|\n${m.cells.map(c=>`| ${c.model} | ${c.task} | ${c.status} | ${clean(c.outcome?.success)} | ${clean(c.error??c.outcome?.reason)} |`).join('\n')}\n\nПриёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.\n${m.error?'\nОшибка: '+clean(m.error)+'\n':''}`);
 appendFileSync(join(dir,'summary.ru.md'),`\n## Профили\n\n${m.profiles.map(p=>`- ${p.id}: ${p.placement??'gpu-only'}, context=${p.contextWindow??32768}`).join('\n')}\n\nВремя hybrid нельзя напрямую сравнивать с gpu-only.\n`);
 if(m.qualifications)appendFileSync(join(dir,'summary.ru.md'),`\n## Квалификация протокола\n\n${Object.entries(m.qualifications).map(([id,q])=>`- ${id}: ${q.passed?'PASS':'FAIL'}, ${q.cases.filter(c=>c.passed).length}/${q.cases.length}; ${q.cases.filter(c=>!c.passed).map(c=>clean(c.error)).join('; ')}`).join('\n')}\n`);
}
/** Link only a verified frozen dependency tree, never the mutable workspace node_modules. */
export function linkFrozenTree(source:string,destination:string):void{
 const stat=lstatSync(source);if(stat.isSymbolicLink())throw Error('Symlink in frozen dependencies');
 if(stat.isDirectory()){
   mkdirSync(destination,{recursive:true});
   for(const name of readdirSync(source))linkFrozenTree(join(source,name),join(destination,name));
 }else if(stat.isFile()){
   try{linkSync(source,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;copyFileSync(source,destination);}
 }else throw Error('Unsupported frozen dependency entry');
}
export async function prepareMatrix(dir:string,specFile:string,reuseDependencies?:string){
 if(existsSync(dir))throw Error('Use a fresh output directory');
 const spec=specSchema.parse(readJson(specFile));
 if(new Set(spec.models).size!==spec.models.length||new Set(spec.tasks).size!==spec.tasks.length)throw Error('Duplicate models/tasks');
 if(Object.keys(spec.profileOverrides).some(id=>!spec.models.includes(id)))throw Error('Profile override references an unselected model');
 const config=loadConfig(),common=join(dir,'common'),snapshot=join(dir,'snapshots/current');
 const supplied=readJson<{models:Profile[];providers:Record<string,any>}>(resolve(root,spec.modelConfig));
 const profiles=spec.models.map(id=>{const p=supplied.models.find(p=>p.id===id);if(!p||p.provider!=='ollama')throw Error(`Missing local model ${id}`);const override=spec.profileOverrides[id];return {...p,placement:override?.placement??'gpu-only' as const,params:{...p.params,...override?.params}};});
 for(const task of spec.tasks)if(!existsSync(join(root,'bench/acceptance',task+'.mjs')))throw Error(`Missing acceptance suite ${task}`);
 const acceptanceImage=pinNodeImage(spec.acceptanceImage);
 mkdirSync(common,{recursive:true});
 for(const [name,source]of [['methodology',config.runner.methodologyDir],['skills',config.runner.skillsDir],['agents',config.runner.agentsDir]] as const){
   inventory(source,readdirSync(source).filter(n=>n!=='.git'));cpSync(source,join(common,name),{recursive:true,filter:src=>relative(source,src).split(sep)[0]!=='.git'});
 }
 cpSync(config.dir,join(common,'config'),{recursive:true});
 const models=readJson<{models:Profile[];providers:Record<string,any>}>(join(common,'config/models.json'));
 models.models=[...models.models.filter(p=>!spec.models.includes(p.id)),...profiles];
 models.providers.ollama.baseUrl=spec.engine.host+'/v1';saveJson(join(common,'config/models.json'),models);
 saveJson(join(common,'config/runner.local.json'),{...config.runner,methodologyDir:join(common,'methodology'),skillsDir:join(common,'skills'),agentsDir:join(common,'agents')});
 if(reuseDependencies){
   const parent=resolve(root,reuseDependencies),back=relative(root,parent);
   if(back.startsWith('..')||!back.split(sep).slice(0,2).every((part,index)=>part===['bench','results'][index]))throw Error('Dependency source must be a workspace benchmark result');
   if(existsSync(join(parent,'run.lock')))throw Error('Dependency source is still running');
   const prior=readJson<Matrix>(join(parent,'manifest.json'));
   if(prior.nodeVersion!==process.version||prior.inputs['package-lock.json']!==inventory(root,['package-lock.json'])['package-lock.json'])throw Error('Frozen dependencies use a different Node version or lockfile');
   const priorCommon=join(parent,'common');
   if(stableDigest(prior.common)!==stableDigest(inventory(priorCommon)))throw Error('Frozen dependency source changed');
   linkFrozenTree(join(priorCommon,'node_modules'),join(common,'node_modules'));
   if(stableDigest(prior.common)!==stableDigest(inventory(priorCommon)))throw Error('Frozen dependency source changed during reuse');
 }else cpSync(join(root,'node_modules'),join(common,'node_modules'),{recursive:true,filter:src=>!['@sdlc-runner','.cache','.bin'].includes(relative(join(root,'node_modules'),src).split(sep)[0]??'')});
 mkdirSync(snapshot,{recursive:true});
 for(const input of INPUTS){inventory(root,[input]);mkdirSync(dirname(join(snapshot,input)),{recursive:true});cpSync(join(root,input),join(snapshot,input),{recursive:true});}
 mkdirSync(join(snapshot,'node_modules'));
 for(const name of readdirSync(join(common,'node_modules')))symlinkSync(join(common,'node_modules',name),join(snapshot,'node_modules',name),'junction');
 mkdirSync(join(snapshot,'node_modules/@sdlc-runner'));symlinkSync(join(snapshot,'shared'),join(snapshot,'node_modules/@sdlc-runner/shared'),'junction');
 const m:Matrix={version:1,status:'prepared',preparedAt:new Date().toISOString(),spec,specHash:stableDigest(spec),acceptanceImage,profiles,
   cells:profiles.flatMap((p,i)=>spec.tasks.flatMap((task,j)=>Array.from({length:spec.repetitions},(_,rep)=>({id:`${i+1}-${j+1}${spec.repetitions>1?'-'+(rep+1):''}`,model:p.id,task,status:'pending'})))),
   inputs:inventory(snapshot,INPUTS),common:inventory(common),coordinatorHash:coordinatorHash(),nodeVersion:process.version};
 emit(dir,m);
}
function assertFrozen(dir:string,m:Matrix){
 if(m.specHash!==stableDigest(m.spec)||m.nodeVersion!==process.version||m.coordinatorHash!==coordinatorHash()||stableDigest(m.inputs)!==stableDigest(inventory(join(dir,'snapshots/current'),INPUTS))||stableDigest(m.common)!==stableDigest(inventory(join(dir,'common'))))throw Error('Frozen inputs changed');
}
const killTree=(pid:number)=>execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
export async function runMatrix(dir:string){
 const m=readJson<Matrix>(join(dir,'manifest.json'));specSchema.parse(m.spec);assertFrozen(dir,m);
 const lock=join(dir,'run.lock');if(existsSync(lock))throw Error('Run lock exists; do not start a duplicate');
 saveJson(lock,{pid:process.pid});let cancelled=false;let engine:ReturnType<typeof spawn>|undefined;let child:ReturnType<typeof spawn>|undefined;
 const qualificationAbort=new AbortController();
 const cancel=()=>{cancelled=true;qualificationAbort.abort(new Error('operator cancellation'));if(child?.pid&&child.exitCode===null)try{killTree(child.pid);}catch{}};
 process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 const deadline=Date.now()+m.spec.limits.suiteHours*3600000;
 const host=m.spec.engine.host,url=new URL(host);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')throw Error('Local dedicated HTTP engine required');
 const request=async(path:string,data?:unknown,timeout=10000)=>{const r=await fetch(host+path,{...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error(`${path}: ${r.status}`);return r.json();};
 const start=(cmd:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,log:string)=>{const fd=openSync(log,'a');const p=spawn(cmd,args,{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});closeSync(fd);return p;};
 const waitGpu=async()=>{const until=Math.min(deadline,Date.now()+m.spec.limits.gpuWaitMinutes*60000);m.status='waiting-gpu';emit(dir,m);
   while(!cancelled){const gpu=execFileSync('nvidia-smi',['--query-gpu=memory.free,utilization.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(l=>l.split(',').map(Number));
    saveJson(join(dir,'gpu.json'),{at:new Date().toISOString(),gpu});
    if(gpu.length===2&&gpu.every((g,i)=>g[0]!>=m.spec.engine.gpuFreeMiB[i]!&&g[1]!<=m.spec.engine.gpuUtilMax[i]!))return;
    if(Date.now()>=until)throw Error('GPU wait budget exhausted; remaining cases not run');await delay(15000);}
 };
 try{
   if(m.cells.some(c=>c.status==='running'))throw Error('Interrupted invocation requires explicit assessment before resuming');
   delete m.error;delete m.finishedAt;
   await waitGpu();if(cancelled)return;
   let occupied=false;try{await request('/api/version');occupied=true;}catch{}if(occupied)throw Error('Dedicated engine port occupied');
   const env:NodeJS.ProcessEnv={...process.env,OLLAMA_HOST:url.host,OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_VULKAN:'false',OLLAMA_SCHED_SPREAD:'true',OLLAMA_LLM_LIBRARY:'cuda_v12',OLLAMA_NO_CLOUD:'true'};delete env.CUDA_VISIBLE_DEVICES;
   if(!env.OLLAMA_MODELS)env.OLLAMA_MODELS=execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')"],{encoding:'utf8',windowsHide:true}).trim();
   const engineLog=join(dir,'engine.log');engine=start('ollama',['serve'],root,env,engineLog);let engineError:Error|undefined;engine.on('error',e=>{engineError=e;});
   let ready=false;for(let i=0;i<100&&!cancelled;i++){if(engineError)throw engineError;if(engine.exitCode!==null)throw Error('Engine exited');try{await request('/api/version');ready=true;break;}catch{await delay(200);}}if(!ready)throw Error('Engine not ready');
   const engineVersion=await request('/api/version');
   if(m.engineVersion&&stableDigest(m.engineVersion)!==stableDigest(engineVersion))throw Error('Engine version changed');m.engineVersion=engineVersion;
   const tags=await request('/api/tags') as {models:{name:string;digest:string}[]};
   const digests=Object.fromEntries(m.profiles.map(p=>{const installed=tags.models.find(t=>t.name===p.model||t.name===p.model+':latest');if(!installed)throw Error(`Model not installed: ${p.model}`);return [p.id,installed.digest];}));
   if(m.modelDigests&&stableDigest(m.modelDigests)!==stableDigest(digests))throw Error('Model digests changed');m.modelDigests=digests;
   m.startedAt??=new Date().toISOString();
   m.qualifications={};
   for(const profile of m.profiles){
     if(cancelled)throw Error('Qualification cancelled');
     m.status='qualifying';m.active=profile.id;emit(dir,m);
     const offset=readFileSync(engineLog,'utf8').length;
     const qualificationStarted=Date.now();
     try{
       await request('/api/generate',{model:profile.model,prompt:'Reply OK.',stream:false,options:{num_ctx:profile.contextWindow??32768,num_predict:1}},300000);
       const layout=await request('/api/ps') as {models:{name:string;size:number;size_vram:number;context_length:number}[]};
       checkPlacement(layout.models.find(p=>p.name===profile.model||p.name===profile.model+':latest'),profile.contextWindow??32768,profile.placement??'gpu-only');
       const log=readFileSync(engineLog,'utf8').slice(offset),gpus=new Set([...log.matchAll(/(CUDA\d+)\s+model buffer/g)].map(x=>x[1])).size;
       if(gpus<1||gpus>2)throw Error('placement: no supported CUDA allocation');assertEngineLog(log,gpus);
       m.qualifications[profile.id]=await qualifyModel({host,model:profile.model,budgetMs:Math.max(1,900000-(Date.now()-qualificationStarted)),signal:qualificationAbort.signal,...(profile.params?{params:profile.params}:{})});
       saveJson(join(dir,`qualification-${m.profiles.indexOf(profile)+1}.json`),{profile,layout,result:m.qualifications[profile.id]});
     }catch(error){m.qualifications[profile.id]={passed:false,elapsedMs:Date.now()-qualificationStarted,cases:[{name:'placement',repetition:0,passed:false,error:String(error)}]};}
     emit(dir,m);await request('/api/generate',{model:profile.model,keep_alive:0},30000).catch(()=>{});
   }
   if(m.profiles.some(p=>!m.qualifications?.[p.id]?.passed)){
     if(m.spec.guidedEngineVersion!==5)throw Error('Qualification failed: full matrix withheld; inspect qualifications');
     for(const c of m.cells.filter(c=>c.status==='pending'&&!m.qualifications?.[c.model]?.passed&&m.qualifications?.[c.model]?.compatible!==true)){c.status='unsupported';c.error='Profile transport/placement qualification failed; task not executed';}
     emit(dir,m);
   }
   for(const c of m.cells.filter(c=>c.status==='pending')){
     if(cancelled)break;if(Date.now()>=deadline)throw Error('Suite time budget exhausted');assertFrozen(dir,m);await waitGpu();if(cancelled)break;
     const profile=m.profiles.find(p=>p.id===c.model)!;m.active=c.id;m.status='loading';emit(dir,m);
     const offset=readFileSync(engineLog,'utf8').length;
     try{
       await request('/api/generate',{model:profile.model,prompt:'Reply OK.',stream:false,options:{num_ctx:profile.contextWindow??32768,num_predict:1}},300000);
       const layout=await request('/api/ps') as {models:{name:string;size:number;size_vram:number;context_length:number;digest:string}[]};const loaded=layout.models.find(x=>x.name===profile.model||x.name===profile.model+':latest');
       checkPlacement(loaded,profile.contextWindow??32768,profile.placement??'gpu-only');
       if(!loaded)throw Error('Loaded model missing');
       if(loaded.digest!==m.modelDigests![profile.id])throw Error('Loaded model digest changed');
       const log=readFileSync(engineLog,'utf8').slice(offset),gpus=new Set([...log.matchAll(/(CUDA\d+)\s+model buffer/g)].map(x=>x[1])).size;
       if(gpus<1||gpus>2)throw Error('No supported CUDA allocation');assertEngineLog(log,gpus);c.layout=layout;
     }catch(error){c.status='complete';c.error=`Engine layout failure: ${String(error)}`;c.finishedAt=new Date().toISOString();emit(dir,m);await request('/api/generate',{model:profile.model,keep_alive:0},30000).catch(()=>{});continue;}
     c.slug='matrix-'+randomUUID();c.status='running';c.startedAt=new Date().toISOString();m.status='running';emit(dir,m);
     const snapshot=join(dir,'snapshots/current'),runDir=join(dir,'runs',c.id,c.slug);mkdirSync(runDir,{recursive:true});
     const common=join(dir,'common');const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SDLC_')));
     const rawLogDir=join(dir,'raw');
     const runEnv={...cleanEnv,SDLC_CONFIG_DIR:join(common,'config'),SDLC_STATE_DIR:join(dir,'state',c.slug),SDLC_METHODOLOGY_DIR:join(common,'methodology'),SDLC_SKILLS_DIR:join(common,'skills'),SDLC_AGENTS_DIR:join(common,'agents'),SDLC_CONSTANTS_PATH:join(common,'methodology/sdlc-constants.json'),SDLC_REVIEW_MODEL:c.model,OLLAMA_BASE_URL:host+'/v1',SDLC_RAW_LOG_DIR:rawLogDir};
     const minutes=Math.min(m.spec.limits.runMinutes,(deadline-Date.now())/60000);c.invocationBudgetMs=minutes*60000;
     child=start(process.execPath,['bench/src/cli.ts','--all','--model',c.model,'--task',c.task,'--execution-mode','guided','--guided-engine-version',String(m.spec.guidedEngineVersion??4),'--preparation-version','3','--strict-questions','--acceptance-image',m.acceptanceImage,'--attempts',String(m.spec.limits.attempts),'--stage-timeout',String(m.spec.limits.stageMinutes),'--run-timeout',String(minutes),'--probe-timeout','1','--slug',c.slug,'--keep-workspace'],snapshot,runEnv,join(runDir,'launcher.log'));
     if(child.pid!==undefined)c.pid=child.pid;emit(dir,m);console.log(`START ${c.id} ${c.model} ${c.task}`);
     let timedOut=false;const timer=setTimeout(()=>{timedOut=true;if(child?.pid&&child.exitCode===null)try{killTree(child.pid);}catch{}},minutes*60000+30000);
     let code:number|null=null;try{code=await new Promise<number|null>((done,fail)=>{child!.once('error',fail);child!.once('close',done);});}finally{clearTimeout(timer);child=undefined;}
     c.finishedAt=new Date().toISOString();c.elapsedMs=Date.parse(c.finishedAt)-Date.parse(c.startedAt);
     const resultPath=join(snapshot,'bench/results',c.slug+'.json'),preflightPath=join(snapshot,'bench/results',c.slug+'.preflight.json');
     const result=existsSync(resultPath)?readJson<BenchResult>(resultPath):null;
     const preflight=existsSync(preflightPath)?readJson<PreflightReport&{slug:string;startedAt:string;finishedAt:string}>(preflightPath):undefined;
     const expected={slug:c.slug,model:c.model,task:c.task,startedAt:c.startedAt,finishedAt:c.finishedAt,guidedEngineVersion:m.spec.guidedEngineVersion??4};c.outcome=assessGuidedValidation(result,expected,code,preflight);
     c.evidence=collectComparisonEvidence(currentGuidedResult(result,expected)?result:null,snapshot,{slug:c.slug,rawLogDir});
     if(timedOut)c.error='Coordinator wall-clock timeout';c.status=cancelled?'interrupted':'complete';
     for(const [file,name]of [[resultPath,'result.json'],[preflightPath,'preflight.json'],[join(snapshot,'bench/traces',c.slug),'traces']] as const)if(existsSync(file))cpSync(file,join(runDir,name),{recursive:true});
     saveJson(join(runDir,'assessment.json'),c);emit(dir,m);console.log(`DONE ${c.id} ${c.outcome.status}`);
     await request('/api/generate',{model:profile.model,keep_alive:0},30000);assertFrozen(dir,m);
   }
   m.status=cancelled?'interrupted':'complete';
 }catch(error){m.status=cancelled?'interrupted':'stopped';m.error=String(error);process.exitCode=1;}
 finally{if(child?.pid&&child.exitCode===null)try{killTree(child.pid);}catch{}if(engine?.pid&&engine.exitCode===null)try{killTree(engine.pid);}catch(error){m.error=(m.error??'')+' Cleanup: '+String(error);}delete m.active;m.finishedAt=new Date().toISOString();emit(dir,m);rmSync(lock,{force:true});process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
async function main(){const [command,...args]=process.argv.slice(2);const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
 const output=value('--output');if(!output)throw Error('--output required');const dir=resolve(root,output),rel=relative(root,dir);if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('Output must be inside workspace');
 if(command==='prepare')await prepareMatrix(dir,resolve(root,value('--spec')??'bench/experiments/guided-matrix-acceptance.json'),value('--reuse-dependencies'));else if(command==='run')await runMatrix(dir);else throw Error('Use prepare|run --output DIR');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e);process.exitCode=1;});
