import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WitokPaths } from '../artifacts/paths.ts';
import type { StageResult } from '../exec/StageExecutor.ts';
import { atomicJson } from '../fs/atomicJson.ts';

/** An execution observation never rewrites a proposed decision as a semantic proof. */
export function observeDecisions(paths:WitokPaths,stage:string,since:number,result:StageResult):StageResult {
  const dir=join(paths.dir,'.runner','decisions',stage);
  const records:{decisionId:string;status:string;at:string;entries:unknown[];extra?:{proposalHash?:unknown}}[]=[];
  let complete=true;
  if(existsSync(dir))for(const name of readdirSync(dir)){
    if(!/^[a-f0-9-]+\.json$/u.test(name))continue;
    try{const file=join(dir,name);if(lstatSync(file).isSymbolicLink())throw Error('Redirected decision journal');const value=JSON.parse(readFileSync(file,'utf8'));
      if(Date.parse(value.at)>=since){if(!Array.isArray(value.entries))throw Error('Invalid decision journal');records.push(value);}
    }catch{complete=false;}
  }
  records.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const accepted=(entry:unknown):boolean=>{
    if(!entry||typeof entry!=='object')return false;
    const row=entry as Record<string,unknown>;
    return row.providerAccepted===true||!('providerAccepted' in row)&&'answer' in row;
  };
  const requests=(entries:unknown[]):number=>entries.filter(accepted).length;
  const categories:Record<string,NonNullable<StageResult['diagnostic']>['category']>={
    'runtime-error':'runtime','environment-error':'environment',stale:'stale','invalid-response':'invalid-response',
    'invalid-field':'invalid-field','invalid-evidence':'invalid-evidence','context-required':'context-required',
    'human-required':'human-required',unsupported:'unsupported',budget:'budget'};
  const failures:Record<string,number>={};
  for(const record of records){const category=categories[record.status];if(category)failures[category]=(failures[category]??0)+1;}
  const stats={decisions:records.length,requests:records.reduce((n,r)=>n+requests(r.entries),0),
    repairs:records.reduce((n,r)=>n+Math.max(0,requests(r.entries)-1),0),complete,
    replays:records.filter(record=>record.status==='replayed').length,
    repeatedRejections:records.filter(record=>record.status==='invalid-response'&&typeof record.extra?.proposalHash==='string').length,failures};
  const latest=records.at(-1),category=latest?categories[latest.status]:undefined;
  const observedCategory = result.envFailure ? 'environment'
    : result.stopCause === 'stage-deadline' || result.stopCause === 'request-timeout' || result.stopCause === 'work-budget' ? 'budget' : category;
  const outcome:StageResult={...result,decisionStats:stats,...(records.length?{modelRequests:stats.requests}:{}),...(!result.ok&&!result.diagnostic?{diagnostic:{category:observedCategory??'unassessed',...(latest?{decisionId:latest.decisionId}:{})}}:{})};
  atomicJson(join(paths.dir,'.runner','decision-observations',`${randomUUID()}.json`),{version:1,stage,at:new Date().toISOString(),ok:result.ok,note:result.note,decisionIds:records.map(r=>r.decisionId),stats,diagnostic:outcome.diagnostic??null});
  return outcome;
}
