import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WitokPaths } from '../artifacts/paths.ts';
import type { StageResult } from '../exec/StageExecutor.ts';
import { atomicJson } from '../fs/atomicJson.ts';

/** An execution observation never rewrites a proposed decision as a semantic proof. */
export function observeDecisions(paths:WitokPaths,stage:string,since:number,result:StageResult):StageResult {
  const dir=join(paths.dir,'.runner','decisions',stage);
  const records:{decisionId:string;status:string;at:string;entries:unknown[]}[]=[];
  let complete=true;
  if(existsSync(dir))for(const name of readdirSync(dir)){
    if(!/^[a-f0-9-]+\.json$/u.test(name))continue;
    try{const file=join(dir,name);if(lstatSync(file).isSymbolicLink())throw Error('Redirected decision journal');const value=JSON.parse(readFileSync(file,'utf8'));
      if(Date.parse(value.at)>=since){if(!Array.isArray(value.entries))throw Error('Invalid decision journal');records.push(value);}
    }catch{complete=false;}
  }
  records.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const stats={decisions:records.length,requests:records.reduce((n,r)=>n+r.entries.length,0),repairs:records.reduce((n,r)=>n+Math.max(0,r.entries.length-1),0),complete};
  const categories:Record<string,'runtime'|'environment'|'stale'|'invalid-response'|'context-required'>={
    'runtime-error':'runtime','environment-error':'environment',stale:'stale','invalid-response':'invalid-response','context-required':'context-required'};
  const latest=records.at(-1),category=latest?categories[latest.status]:undefined;
  const outcome:StageResult={...result,decisionStats:stats,...(!result.ok&&!result.diagnostic?{diagnostic:{category:category??'unassessed',...(latest?{decisionId:latest.decisionId}:{})}}:{})};
  atomicJson(join(paths.dir,'.runner','decision-observations',`${randomUUID()}.json`),{version:1,stage,at:new Date().toISOString(),ok:result.ok,note:result.note,decisionIds:records.map(r=>r.decisionId),stats,diagnostic:outcome.diagnostic??null});
  return outcome;
}
