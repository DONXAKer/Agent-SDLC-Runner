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
import {throughputFromQualification,wallclockScale,type ThroughputPassport} from '../bench/src/modelPassport.ts';
import {FAILURE_CLASSES,classifyFailure,compareFailureClasses,type FailureClass} from '../bench/src/failureClass.ts';
import {guidedFunnel,renderGuidedFunnel} from '../bench/src/guidedFunnel.ts';
import {cellAdmission,controlRowProblem,formatSourceDiff,pilotGate,shiftLabel,sourceDiff,type PilotGateVerdict,type SourceDiff} from '../bench/src/seriesDiscipline.ts';
import {loadPacketProfile} from '../bench/src/contextPreflight.ts';
import { acquireProcessLock, releaseProcessLock } from '../server/src/fs/processLock.ts';
import { MatrixControl } from './matrixControl.ts';

const root=resolve(import.meta.dirname,'..');
// Потолок моделей — шесть кандидатов плюс обязательный контрольный ряд.
const specSchema=z.object({modelConfig:z.string(),models:z.array(z.string()).min(1).max(7),tasks:z.array(z.string()).min(1).max(5),acceptanceImage:z.string(),
 guidedEngineVersion:z.union([z.literal(4),z.literal(5)]).default(4),repetitions:z.number().int().min(1).max(3).default(1),
 // Сильный контрольный ряд — подмножество models: без него «модели слабые» неотличимо от «раннер отвергает верные ответы».
 control:z.array(z.string()).min(1),
 profileOverrides:z.record(z.string(),z.object({placement:placementPolicy.default('gpu-only'),params:z.record(z.string(),z.unknown()).optional()})).default({}),
 limits:z.object({stageMinutes:z.number().positive(),runMinutes:z.number().positive(),attempts:z.number().int().positive(),gpuWaitMinutes:z.number().positive(),suiteHours:z.number().positive(),
   // Стенные часы по паспорту: stage/run-лимиты умножаются на (секунд на решение ÷ опора), 1..maxScale. Без блока — лимиты как есть.
   wallclock:z.object({referenceDecisionSeconds:z.number().positive(),maxScale:z.number().min(1).default(3)}).optional()}),
 engine:z.object({host:z.string().url(),gpuFreeMiB:z.array(z.number()).length(2),gpuUtilMax:z.array(z.number()).length(2)})});
type Spec=z.infer<typeof specSchema>;
type Profile={id:string;provider:string;model:string;contextWindow?:number;params?:Record<string,unknown>;placement?:'gpu-only'|'hybrid';reasoning?:'none'|'light'|'heavy'};
type Cell={id:string;model:string;task:string;status:string;slug?:string;startedAt?:string;finishedAt?:string;pid?:number;elapsedMs?:number;outcome?:ReturnType<typeof assessGuidedValidation>;evidence?:ReturnType<typeof collectComparisonEvidence>;error?:string;layout?:unknown;invocationBudgetMs?:number;wallclockScale?:number;stageMinutes?:number;failureClass?:FailureClass};
type Matrix={version:1;status:string;preparedAt:string;spec:Spec;specHash:string;acceptanceImage:string;profiles:Profile[];cells:Cell[];inputs:Record<string,string>;common:Record<string,string>;coordinatorHash:string;nodeVersion:string;modelDigests?:Record<string,string>;qualifications?:Record<string,Qualification>;passports?:Record<string,ThroughputPassport|null>;engineVersion?:unknown;startedAt?:string;finishedAt?:string;error?:string;active?:string;
 /** Предыдущий прогон той же матрицы (`compare --previous`): классы отказов по ключу клетки — для колонки «Сдвиг». */
 previous?:{dir:string;classes:Record<string,FailureClass>};
 /** Пилот 1×1×≥3, открывший эту матрицу (`prepare --pilot`); у самого пилота поля нет. */
 pilot?:{dir:string;verdict:PilotGateVerdict};
 /** Что изменилось в замороженных входах относительно предыдущей серии (`prepare --previous`, иначе — относительно пилота). */
 sourceChange?:{previous:string}&SourceDiff};
const coordinatorHash=()=>stableDigest(inventory(root,['tools/guided-matrix.ts','tools/matrixControl.ts','server/src/fs/processLock.ts','server/src/fs/atomicJson.ts','bench/src/harnessComparison.ts','bench/src/guidedValidation.ts','bench/src/modelPassport.ts','bench/src/failureClass.ts','bench/src/guidedFunnel.ts','bench/src/seriesDiscipline.ts','bench/src/contextPreflight.ts','tools/guided-suite-success.ts']));
/** Пауза серии до первой клетки (GPU занят дольше бюджета ещё на старте) — не ошибка координатора. */
class PauseSignal extends Error{constructor(){super('Series paused: GPU wait budget exhausted before the first cell');}}
/** Пилот — одна пара (модель, задача): матрица шире не стартует без его манифеста. */
const isPilotShape=(spec:Pick<Spec,'models'|'tasks'>)=>spec.models.length===1&&spec.tasks.length===1;
/** Ключ клетки, устойчивый к порядку моделей в спецификации: модель × задача × повтор. */
export const cellKey=(c:Pick<Cell,'id'|'model'|'task'>)=>`${c.model}|${c.task}|${c.id.split('-')[2]??'1'}`;
/** Класс отказа клетки: записанный стендом либо посчитанный по `result.json` прогона, записанного до появления поля. */
export function cellFailureClass(dir:string,c:Cell):FailureClass|null{
 if(c.failureClass)return c.failureClass;
 if(!c.outcome||!c.slug)return null;
 const resultPath=join(dir,'runs',c.id,c.slug,'result.json');
 const result=existsSync(resultPath)?readJson<BenchResult>(resultPath):null;
 return classifyFailure({success:c.outcome.success,status:c.outcome.status,environmentFailure:c.outcome.environmentFailure,coordinatorError:c.error??null,result});
}
function emit(dir:string,m:Matrix){
 saveJson(join(dir,'manifest.json'),m);
 const clean=(x:unknown)=>String(x??'неизвестно').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
 // «Сдвиг» при одном повторе — шум стохастической модели, не сигнал: подпись говорит это явно.
 const shift=(c:Cell)=>m.previous?shiftLabel(m.previous.classes[cellKey(c)],c.failureClass,m.spec.repetitions):'';
 writeFileSync(join(dir,'summary.ru.md'),`# Полный guided-цикл с независимой приёмкой\n\nСтатус: **${m.status}**. Завершено: ${m.cells.filter(c=>c.status==='complete').length}/${m.cells.length}. Успех: ${m.cells.filter(c=>c.outcome?.success).length}.\n\n| Модель | Задача | Статус | Успех | Класс отказа |${m.previous?' Сдвиг |':''} Причина |\n|---|---|---|---|---|${m.previous?'---|':''}---|\n${m.cells.map(c=>`| ${c.model} | ${c.task} | ${c.status} | ${clean(c.outcome?.success)} | ${c.failureClass??'—'} |${m.previous?` ${shift(c)} |`:''} ${clean(c.error??c.outcome?.reason)} |`).join('\n')}\n\nПриёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.\n\nКласс отказа — закрытый словарь \`bench/src/failureClass.ts\` по структурным полям результата (не по тексту причины): ${FAILURE_CLASSES.join(', ')}.${m.previous?` Сдвиг — относительно \`${m.previous.dir}\`.`:''}\n${m.error?'\nОшибка: '+clean(m.error)+'\n':''}`);
 appendFileSync(join(dir,'summary.ru.md'),`\n${renderGuidedFunnel(guidedFunnel(m.cells))}\n`);
 const control=m.spec.control??[];
 appendFileSync(join(dir,'summary.ru.md'),`\n## Дисциплина серии\n\n- Контрольный ряд: ${control.length?control.join(', '):'не задан в спецификации'}.\n- Пилот: ${m.pilot?`\`${m.pilot.dir}\` — ${clean(m.pilot.verdict.reason)}`:isPilotShape(m.spec)?`эта серия и есть пилот (${m.spec.repetitions} повт.)`:'не записан'}.\n- Исходники относительно предыдущей серии: ${m.sourceChange?`\`${m.sourceChange.previous}\` — ${clean(formatSourceDiff(m.sourceChange))}`:'предыдущая серия не указана'}.\n- Клетки класса \`preflight\` (${m.cells.filter(c=>c.failureClass==='preflight').length}) не запускались: квалификация FAIL, паспорт выше потолка часов или пакет решения не влезает в окно — это не отказ модели.\n${m.status==='paused'?'- Серия ПРИОСТАНОВЛЕНА: GPU занят дольше бюджета ожидания; возобновление — тем же `run`, клетки `pending` сохранены.\n':''}`);
 appendFileSync(join(dir,'summary.ru.md'),`\n## Профили\n\n${m.profiles.map(p=>`- ${p.id}: ${p.placement??'gpu-only'}, context=${p.contextWindow??32768}`).join('\n')}\n\nВремя hybrid нельзя напрямую сравнивать с gpu-only.\n`);
 if(m.qualifications)appendFileSync(join(dir,'summary.ru.md'),`\n## Квалификация протокола\n\n${Object.entries(m.qualifications).map(([id,q])=>`- ${id}: ${q.passed?'PASS':'FAIL'}, ${q.cases.filter(c=>c.passed).length}/${q.cases.length}; ${q.cases.filter(c=>!c.passed).map(c=>clean(c.error)).join('; ')}`).join('\n')}\n`);
 if(m.passports)appendFileSync(join(dir,'summary.ru.md'),`\n## Паспорт скорости (по квалификации)\n\n${Object.entries(m.passports).map(([id,p])=>p?`- ${id}: ${p.secondsPerDecision} с/решение, ${p.tokensPerSecond} ток/с, reasoning ≈${p.reasoningShare} выдачи; стенные часы ×${wallclockScale(p,m.spec.limits.wallclock)}`:`- ${id}: паспорта нет (usage не получен) — лимиты без масштаба`).join('\n')}\n\n${m.spec.limits.wallclock?`Опора ${m.spec.limits.wallclock.referenceDecisionSeconds} с/решение, потолок ×${m.spec.limits.wallclock.maxScale}.`:'Масштаб стенных часов в спецификации не задан: лимиты одинаковы для всех профилей.'}\n`);
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
export async function prepareMatrix(dir:string,specFile:string,reuseDependencies?:string,referenceEnvironment?:string,discipline:{pilot?:string;previous?:string}={}){
 if(existsSync(dir))throw Error('Use a fresh output directory');
 const spec=specSchema.parse(readJson(specFile));
 if(new Set(spec.models).size!==spec.models.length||new Set(spec.tasks).size!==spec.tasks.length)throw Error('Duplicate models/tasks');
 if(Object.keys(spec.profileOverrides).some(id=>!spec.models.includes(id)))throw Error('Profile override references an unselected model');
 const controlProblem=controlRowProblem(spec);if(controlProblem!==null)throw Error(controlProblem);
 // Матрица шире 1×1 открывается только пилотом: одна пара с ≥3 повторами и успехом, на том же протоколе.
 let pilot:Matrix['pilot'];
 if(!isPilotShape(spec)){
   if(!discipline.pilot)throw Error('Matrix wider than 1×1 requires --pilot DIR: a 1 model × 1 task × ≥3 repetitions series with a success');
   const pilotDir=resolve(root,discipline.pilot);const prior=readJson<Matrix>(join(pilotDir,'manifest.json'));
   if(existsSync(join(pilotDir,'run.lock')))throw Error('Pilot is still running');
   if((prior.spec.guidedEngineVersion??4)!==(spec.guidedEngineVersion??4))throw Error('Pilot ran a different guided engine version');
   const verdict=pilotGate({cells:prior.cells.map(c=>({model:c.model,task:c.task,success:c.outcome?.success??null}))});
   if(!verdict.ok)throw Error(`Pilot gate: ${verdict.reason}`);
   pilot={dir:relative(root,pilotDir),verdict};
 }else if(spec.repetitions<3)throw Error('Pilot requires repetitions ≥ 3');
 const config=loadConfig(),common=join(dir,'common'),snapshot=join(dir,'snapshots/current');
 const supplied=readJson<{models:Profile[];providers:Record<string,any>}>(resolve(root,spec.modelConfig));
 const profiles=spec.models.map(id=>{const p=supplied.models.find(p=>p.id===id);if(!p||p.provider!=='ollama')throw Error(`Missing local model ${id}`);const override=spec.profileOverrides[id];return {...p,placement:override?.placement??'gpu-only' as const,params:{...p.params,...override?.params}};});
 for(const task of spec.tasks)if(!existsSync(join(root,'bench/acceptance',task+'.mjs')))throw Error(`Missing acceptance suite ${task}`);
 const reference=referenceEnvironment?readJson<Matrix>(join(referenceEnvironment,'manifest.json')):undefined;
 if(referenceEnvironment && (!reuseDependencies || resolve(reuseDependencies)!==resolve(referenceEnvironment)))throw Error('Verified environment requires its frozen dependencies');
 if(referenceEnvironment && stableDigest(reference!.common)!==stableDigest(inventory(join(referenceEnvironment,'common'))))throw Error('Reference environment changed');
 const acceptanceImage=reference?.acceptanceImage??pinNodeImage(spec.acceptanceImage);
 mkdirSync(common,{recursive:true});
 for(const [name,original]of [['methodology',config.runner.methodologyDir],['skills',config.runner.skillsDir],['agents',config.runner.agentsDir]] as const){
   const source=referenceEnvironment?join(referenceEnvironment,'common',name):original;
   inventory(source,readdirSync(source).filter(n=>n!=='.git'));cpSync(source,join(common,name),{recursive:true,filter:src=>relative(source,src).split(sep)[0]!=='.git'});
 }
 cpSync(referenceEnvironment?join(referenceEnvironment,'common/config'):config.dir,join(common,'config'),{recursive:true});
 const models=readJson<{models:Profile[];providers:Record<string,any>}>(join(common,'config/models.json'));
 models.models=[...models.models.filter(p=>!spec.models.includes(p.id)),...profiles];
 models.providers.ollama.baseUrl=spec.engine.host+'/v1';saveJson(join(common,'config/models.json'),models);
 const runner=referenceEnvironment?readJson<Record<string,unknown>>(join(referenceEnvironment,'common/config/runner.local.json')):config.runner;
 saveJson(join(common,'config/runner.local.json'),{...runner,methodologyDir:join(common,'methodology'),skillsDir:join(common,'skills'),agentsDir:join(common,'agents')});
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
 if(reference){m.engineVersion=reference.engineVersion;m.modelDigests=Object.fromEntries(Object.entries(reference.modelDigests??{}).filter(([id])=>profiles.some(p=>p.id===id)));}
 if(pilot)m.pilot=pilot;
 // Отпечаток входов относительно предыдущей серии (или пилота): журнал обязан назвать ОДНО изменение,
 // а манифест — показать, сколько их было на самом деле.
 const previousDir=discipline.previous?resolve(root,discipline.previous):pilot?resolve(root,pilot.dir):undefined;
 if(previousDir){const prior=readJson<Matrix>(join(previousDir,'manifest.json'));m.sourceChange={previous:relative(root,previousDir),...sourceDiff({files:prior.inputs},{files:m.inputs})};}
 emit(dir,m);
}
function assertFrozen(dir:string,m:Matrix){
 if(m.specHash!==stableDigest(m.spec)||m.nodeVersion!==process.version||m.coordinatorHash!==coordinatorHash()||stableDigest(m.inputs)!==stableDigest(inventory(join(dir,'snapshots/current'),INPUTS))||stableDigest(m.common)!==stableDigest(inventory(join(dir,'common'))))throw Error('Frozen inputs changed');
}
const killTree=(pid:number)=>execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
export async function runMatrix(dir:string,options:{stopOnFailure?:boolean;signal?:AbortSignal}={}){
 const m=readJson<Matrix>(join(dir,'manifest.json'));specSchema.parse(m.spec);assertFrozen(dir,m);
 const host=m.spec.engine.host,url=new URL(host);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')throw Error('Local dedicated HTTP engine required');
 const lock=join(dir,'run.lock'),lease=acquireProcessLock(lock);
 let cancelled=false;let engine:ReturnType<typeof spawn>|undefined;let child:ReturnType<typeof spawn>|undefined;
 const control=new MatrixControl(options.stopOnFailure);
 const cancel=()=>{cancelled=true;control.cancel();if(child?.pid&&child.exitCode===null)try{killTree(child.pid);}catch{}};
 options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
 process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 const deadline=Date.now()+m.spec.limits.suiteHours*3600000;
 const request=(path:string,data?:unknown,timeout=10000)=>control.request(host,path,data,timeout);
 const start=(cmd:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,log:string)=>{const fd=openSync(log,'a');const p=spawn(cmd,args,{cwd,env,windowsHide:true,stdio:['ignore',fd,fd]});closeSync(fd);return p;};
 // Исчерпанный бюджет ожидания GPU — пауза серии, не `stopped`: клетки остаются `pending`, возобновление — тем же `run`.
 // r2 (2026-10-28) оборвался так на 15/30 — часы, которые ничего не измерили. Остановить серию может только `suiteHours`.
 let paused=false;
 const waitGpu=async():Promise<boolean>=>{const until=Math.min(deadline,Date.now()+m.spec.limits.gpuWaitMinutes*60000);m.status='waiting-gpu';emit(dir,m);
   while(!cancelled){const gpu=execFileSync('nvidia-smi',['--query-gpu=memory.free,utilization.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(l=>l.split(',').map(Number));
    saveJson(join(dir,'gpu.json'),{at:new Date().toISOString(),gpu});
    if(gpu.length===2&&gpu.every((g,i)=>g[0]!>=m.spec.engine.gpuFreeMiB[i]!&&g[1]!<=m.spec.engine.gpuUtilMax[i]!))return true;
     if(Date.now()>=until){if(Date.now()>=deadline)throw Error('Suite time budget exhausted');paused=true;m.error=`GPU busy longer than ${m.spec.limits.gpuWaitMinutes} min: series paused, pending cells kept; resume with the same run`;return false;}
     await delay(15000,undefined,{signal:control.signal});}
   return false;
 };
 // Допуск клетки до загрузки модели: квалификация FAIL, паспорт выше потолка часов, пакет решения не влезает в окно —
 // класс `preflight`, модель не измерялась. Прежде FAIL квалификации на v5 с «совместимым» транспортом всё равно гонял клетки
 // (ministral 8/12 — пять клеток r1–r3), а devstral ×3 по паспорту упирался в лимит plan.
 const admit=(c:Cell,profile:Profile)=>{const packets=loadPacketProfile(join(root,'bench'),c.task);
   return cellAdmission({qualification:m.qualifications?.[c.model],passport:m.passports?.[c.model],wallclock:m.spec.limits.wallclock,
     context:packets===null?null:{profile:packets,contextWindow:profile.contextWindow??32768,reasoning:profile.reasoning}});};
 try{
   if(m.cells.some(c=>c.status==='running'))throw Error('Interrupted invocation requires explicit assessment before resuming');
   delete m.error;delete m.finishedAt;
   for(const existing of m.cells)control.complete(existing);
   control.assertMayStart();if(!await waitGpu())throw new PauseSignal();control.assertMayStart();
   let occupied=false;try{await request('/api/version');occupied=true;}catch{}if(occupied)throw Error('Dedicated engine port occupied');
   const env:NodeJS.ProcessEnv={...process.env,OLLAMA_HOST:url.host,OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_VULKAN:'false',OLLAMA_SCHED_SPREAD:'true',OLLAMA_LLM_LIBRARY:'cuda_v12',OLLAMA_NO_CLOUD:'true'};delete env.CUDA_VISIBLE_DEVICES;
   if(!env.OLLAMA_MODELS)env.OLLAMA_MODELS=execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')"],{encoding:'utf8',windowsHide:true}).trim();
   const engineLog=join(dir,'engine.log');engine=start('ollama',['serve'],root,env,engineLog);let engineError:Error|undefined;engine.on('error',e=>{engineError=e;});
   let ready=false;for(let i=0;i<100&&!cancelled;i++){if(engineError)throw engineError;if(engine.exitCode!==null)throw Error('Engine exited');try{await request('/api/version');ready=true;break;}catch{await delay(200);}}if(!ready)throw Error('Engine not ready');
   const engineVersion=await request('/api/version');
   if(m.engineVersion&&stableDigest(m.engineVersion)!==stableDigest(engineVersion))throw Error('Engine version changed');m.engineVersion=engineVersion;
   const tags=await request('/api/tags') as {models:{name:string;digest:string}[]};
   const digests=Object.fromEntries(m.profiles.map(p=>{const installed=tags.models.find(t=>t.name===p.model||t.name===p.model+':latest');if(!installed)throw Error(`Model not installed: ${p.model}`);return [p.id,installed.digest];}));
   if(m.modelDigests&&Object.entries(m.modelDigests).some(([id,digest])=>digests[id]!==digest))throw Error('Model digests changed');m.modelDigests=digests;
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
       m.qualifications[profile.id]=await qualifyModel({host,model:profile.model,budgetMs:Math.max(1,900000-(Date.now()-qualificationStarted)),signal:control.signal,...(profile.params?{params:profile.params}:{})});
       // Паспорт скорости снимается с тех же проб: отдельного замера с другим промптом не нужно.
       (m.passports??={})[profile.id]=throughputFromQualification(m.qualifications[profile.id]!);
       saveJson(join(dir,`qualification-${m.profiles.indexOf(profile)+1}.json`),{profile,layout,result:m.qualifications[profile.id],passport:m.passports![profile.id]});
     }catch(error){if(cancelled)throw error;m.qualifications[profile.id]={passed:false,elapsedMs:Date.now()-qualificationStarted,cases:[{name:'placement',repetition:0,passed:false,error:String(error)}]};(m.passports??={})[profile.id]=null;}
     emit(dir,m);await request('/api/generate',{model:profile.model,keep_alive:0},30000).catch(()=>{});
   }
   for(const c of m.cells.filter(c=>c.status==='pending')){
     const profile=m.profiles.find(p=>p.id===c.model)!;
     const admission=admit(c,profile);
     if(!admission.admit){c.status='complete';c.failureClass=admission.failureClass;c.error=`Preflight: ${admission.reason}`;c.finishedAt=new Date().toISOString();emit(dir,m);console.log(`SKIP ${c.id} ${c.model} ${c.task}: ${admission.reason}`);continue;}
     control.assertMayStart();
     if(cancelled)break;if(Date.now()>=deadline)throw Error('Suite time budget exhausted');assertFrozen(dir,m);if(!await waitGpu())break;if(cancelled)break;
     m.active=c.id;m.status='loading';emit(dir,m);
     const offset=readFileSync(engineLog,'utf8').length;
     try{
       await request('/api/generate',{model:profile.model,prompt:'Reply OK.',stream:false,options:{num_ctx:profile.contextWindow??32768,num_predict:1}},300000);
       const layout=await request('/api/ps') as {models:{name:string;size:number;size_vram:number;context_length:number;digest:string}[]};const loaded=layout.models.find(x=>x.name===profile.model||x.name===profile.model+':latest');
       checkPlacement(loaded,profile.contextWindow??32768,profile.placement??'gpu-only');
       if(!loaded)throw Error('Loaded model missing');
       if(loaded.digest!==m.modelDigests![profile.id])throw Error('Loaded model digest changed');
       const log=readFileSync(engineLog,'utf8').slice(offset),gpus=new Set([...log.matchAll(/(CUDA\d+)\s+model buffer/g)].map(x=>x[1])).size;
       if(gpus<1||gpus>2)throw Error('No supported CUDA allocation');assertEngineLog(log,gpus);c.layout=layout;
     }catch(error){if(cancelled)throw error;c.status='complete';c.error=`Engine layout failure: ${String(error)}`;c.failureClass='env';c.finishedAt=new Date().toISOString();emit(dir,m);control.complete(c);control.assertMayStart();await request('/api/generate',{model:profile.model,keep_alive:0},30000).catch(()=>{});continue;}
     // Cancellation can arrive while awaiting model load/placement. Never spawn
     // another benchmark child after the stop was already acknowledged.
     if(cancelled)break;
     control.assertMayStart();
     c.slug='matrix-'+randomUUID();c.status='running';c.startedAt=new Date().toISOString();m.status='running';emit(dir,m);
     const snapshot=join(dir,'snapshots/current'),runDir=join(dir,'runs',c.id,c.slug);mkdirSync(runDir,{recursive:true});
     const common=join(dir,'common');const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SDLC_')));
     const rawLogDir=join(dir,'raw');
     const runEnv={...cleanEnv,SDLC_CONFIG_DIR:join(common,'config'),SDLC_STATE_DIR:join(dir,'state',c.slug),SDLC_METHODOLOGY_DIR:join(common,'methodology'),SDLC_SKILLS_DIR:join(common,'skills'),SDLC_AGENTS_DIR:join(common,'agents'),SDLC_CONSTANTS_PATH:join(common,'methodology/sdlc-constants.json'),SDLC_REVIEW_MODEL:c.model,OLLAMA_BASE_URL:host+'/v1',SDLC_RAW_LOG_DIR:rawLogDir};
     // Лимиты стенных часов — по паспорту скорости профиля (1..maxScale), но не дольше остатка серии.
     // Тем же коэффициентом — бюджет работы рантайма (`--work-wallclock-scale`): r7 показал,
     // что без него клетка упирается в 50 мин бюджета конфига при лимите клетки в 209 мин.
     const scale=wallclockScale(m.passports?.[c.model]??null,m.spec.limits.wallclock);c.wallclockScale=scale;
     const stageMinutes=m.spec.limits.stageMinutes*scale;c.stageMinutes=stageMinutes;
     const minutes=Math.min(m.spec.limits.runMinutes*scale,(deadline-Date.now())/60000);c.invocationBudgetMs=minutes*60000;
     child=start(process.execPath,['bench/src/cli.ts','--all','--model',c.model,'--task',c.task,'--execution-mode','guided','--guided-engine-version',String(m.spec.guidedEngineVersion??4),'--preparation-version','3','--strict-questions','--acceptance-image',m.acceptanceImage,'--attempts',String(m.spec.limits.attempts),'--stage-timeout',String(stageMinutes),'--run-timeout',String(minutes),'--work-wallclock-scale',String(scale),'--probe-timeout','1','--placement',profile.placement??'gpu-only','--slug',c.slug,'--keep-workspace'],snapshot,runEnv,join(runDir,'launcher.log'));
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
     c.failureClass=classifyFailure({success:c.outcome.success,status:c.outcome.status,environmentFailure:c.outcome.environmentFailure,coordinatorError:c.error??null,result:currentGuidedResult(result,expected)?result:null});
     for(const [file,name]of [[resultPath,'result.json'],[preflightPath,'preflight.json'],[join(snapshot,'bench/traces',c.slug),'traces']] as const)if(existsSync(file))cpSync(file,join(runDir,name),{recursive:true});
     saveJson(join(runDir,'assessment.json'),c);emit(dir,m);console.log(`DONE ${c.id} ${c.outcome.status}`);
     control.complete(c);control.assertMayStart();
     await request('/api/generate',{model:profile.model,keep_alive:0},30000);assertFrozen(dir,m);
   }
   m.status=cancelled?'interrupted':paused?'paused':'complete';
 }catch(error){
   if(error instanceof PauseSignal&&!cancelled){m.status='paused';}
   else{m.status=cancelled?'interrupted':'stopped';m.error=String(error);process.exitCode=1;}
 }
 finally{
   if(child?.pid&&child.exitCode===null)try{killTree(child.pid);}catch{}
   if(engine?.pid&&engine.exitCode===null)try{killTree(engine.pid);}catch(error){m.error=(m.error??'')+' Cleanup: '+String(error);}
   delete m.active;m.finishedAt=new Date().toISOString();
   try{emit(dir,m);}finally{
     try{releaseProcessLock(lock,lease);}finally{
       process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);options.signal?.removeEventListener('abort',cancel);
     }
   }
 }
}
/**
 * Сдвиг классов отказа относительно предыдущего прогона той же матрицы. Пишет
 * `compare.ru.md`; если прогон не идёт (нет `run.lock`), запоминает предыдущий прогон в
 * манифесте и перерисовывает `summary.ru.md` с колонкой «Сдвиг». У идущего прогона манифест
 * держит координатор в памяти — его файл не трогаем, иначе запись потерялась бы при следующем emit.
 */
export function compareMatrix(dir:string,previousDir:string):{rows:ReturnType<typeof compareFailureClasses>;persisted:boolean;repetitions:number}{
 const m=readJson<Matrix>(join(dir,'manifest.json')),prior=readJson<Matrix>(join(previousDir,'manifest.json'));
 if(m.specHash!==prior.specHash)console.warn('Спецификации прогонов различаются: сдвиг классов сравнивает разные условия');
 const classesOf=(root:string,cells:Cell[])=>cells.flatMap(c=>{const failureClass=cellFailureClass(root,c);return failureClass===null?[]:[{key:cellKey(c),failureClass}];});
 const rows=compareFailureClasses(classesOf(dir,m.cells),classesOf(previousDir,prior.cells));
 for(const c of m.cells){const failureClass=cellFailureClass(dir,c);if(failureClass!==null)c.failureClass=failureClass;}
 const relPrevious=relative(dir,previousDir)||'.';
 const repetitions=m.spec.repetitions??1;
 // Смена класса при одном повторе — наблюдение, не сдвиг: стохастическая модель меняет класс и без правок кода.
 const shiftWord=repetitions<2?'смена (n=1 — не сдвиг)':'да';
 const sourceNote=m.sourceChange?`\n\nИсходники относительно \`${m.sourceChange.previous}\`: ${formatSourceDiff(m.sourceChange)}.`:'';
 writeFileSync(join(dir,'compare.ru.md'),`# Сдвиг классов отказа\n\nТекущий: \`${relative(root,dir)}\`, предыдущий: \`${relative(root,previousDir)}\`. Повторов: ${repetitions}.\n\n| Клетка | Было | Стало | Сдвиг |\n|---|---|---|---|\n${rows.map(r=>`| ${r.key} | ${r.from??'—'} | ${r.to} | ${r.changed?shiftWord:r.from===null?'нет данных':'нет'} |`).join('\n')}\n\nКлассы: ${FAILURE_CLASSES.join(', ')}. Одинаковый класс на двух прогонах подряд — узкое место не сдвинулось; смена класса на том же этапе при ≥2 повторах — фикс сработал, модель упёрлась дальше; при одном повторе смена класса утверждением о сдвиге не является.${sourceNote}\n`);
 const persisted=!existsSync(join(dir,'run.lock'));
 if(persisted){m.previous={dir:relPrevious,classes:Object.fromEntries(classesOf(previousDir,prior.cells).map(c=>[c.key,c.failureClass]))};emit(dir,m);}
 return {rows,persisted,repetitions};
}
async function main(){const [command,...args]=process.argv.slice(2);const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
 const output=value('--output');if(!output)throw Error('--output required');const dir=resolve(root,output),rel=relative(root,dir);if(!rel||rel.startsWith('..')||rel.includes(':'))throw Error('Output must be inside workspace');
 if(command==='prepare'){const pilot=value('--pilot'),previous=value('--previous');
   await prepareMatrix(dir,resolve(root,value('--spec')??'bench/experiments/guided-matrix-acceptance.json'),value('--reuse-dependencies'),undefined,{...(pilot?{pilot}:{}),...(previous?{previous}:{})});}
 else if(command==='run')await runMatrix(dir);
 else if(command==='compare'){const previous=value('--previous');if(!previous)throw Error('--previous DIR required');const {rows,persisted,repetitions}=compareMatrix(dir,resolve(root,previous));for(const r of rows)console.log(`${r.key}: ${shiftLabel(r.from??undefined,r.to,repetitions)}`);if(!persisted)console.log('Прогон идёт: записан только compare.ru.md');}
 else throw Error('Use prepare --output DIR [--spec FILE] [--pilot DIR] [--previous DIR] | run --output DIR | compare --output DIR --previous DIR');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e);process.exitCode=1;});
