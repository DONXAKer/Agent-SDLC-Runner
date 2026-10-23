import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readArtifact } from '../artifacts/artifact.ts';
import { preparation } from '../artifacts/preparation.ts';
import type { WitokPaths } from '../artifacts/paths.ts';
import { symlinkEscape } from '../approval/symlink.ts';
import { progressHash } from './guidedProgress.ts';
import type { DecisionContext } from '../exec/decisionEngine.ts';
import { createHash } from 'node:crypto';

/** State and source identities are recaptured for every individual decision and before acceptance. */
export function decisionOptions(paths: WitokPaths, stage: string, contextWindow: number, onValidation?: (result:{questionId:string;accepted:boolean;reason:string})=>void) {
  const source = (name:string):string|null => {
    const path=resolve(paths.projectRoot,name),back=relative(paths.projectRoot,path);
    if(isAbsolute(back)||back.startsWith('..')||symlinkEscape(paths.projectRoot,path,[])!==null)throw Error('Decision source escapes workspace');
    return existsSync(path)?readFileSync(path,'utf8'):null;
  };
  return { directory: join(paths.dir, '.runner', 'decisions', stage), contextWindow, ...(onValidation?{onValidation}:{}),
    validateQuestion(question:unknown):void {
      const check=(path:string,text?:string,hash?:string,isNew=false)=>{
        const full=source(path);
        if(isNew){if(full!==null)throw Error(`New source ${path} already exists`);return;}
        if(full===null)throw Error(`Source ${path} is missing`);
        if(hash&&hash!==progressHash(full)&&hash!==createHash('sha256').update(full).digest('hex'))throw Error(`Source hash changed: ${path}`);
        if(text!==undefined&&!full.replace(/\r\n/gu,'\n').includes(text.replace(/\r\n/gu,'\n')))throw Error(`Shown source is stale: ${path}`);
      };
      const walk=(value:unknown,key='')=>{
        if(Array.isArray(value)){for(const row of value)walk(row,key);return;}
        if(!value||typeof value!=='object')return;
        const row=value as Record<string,unknown>;
        if(Array.isArray(row.sourcePackets))for(const packet of row.sourcePackets){
          if(!packet||typeof packet.path!=='string'||typeof packet.hash!=='string')throw Error('Invalid source packet');
          const text=row.sources&&typeof row.sources==='object'?(row.sources as Record<string,unknown>)[packet.path]:undefined;
          if(typeof text!=='string')throw Error(`Missing supplied source: ${packet.path}`);
          check(packet.path,text,packet.hash);
        }
        if(['source','files','fragments','sourcePackets'].includes(key)&&typeof row.path==='string'){
          const text=typeof row.content==='string'?row.content:typeof row.text==='string'?row.text:undefined;
          const hash=typeof row.hash==='string'?row.hash:undefined;
          if(text!==undefined||hash!==undefined||row.isNew===true)check(row.path,text,hash,row.isNew===true);
        }
        for(const [name,child]of Object.entries(row))walk(child,name);
      };
      walk(question);
    }, capture(): DecisionContext {
    const state = preparation(paths);
    const documents = { intent: readArtifact(paths.intent).text, clarification: readArtifact(paths.clarificationReport).text,
      plan: readArtifact(paths.plan).text };
    const sourceVersions: Record<string, string> = {};
    for (const row of state?.readEvidence ?? []) {
      const path = resolve(paths.projectRoot, row.path), back = relative(paths.projectRoot, path);
      if (isAbsolute(back) || back.startsWith('..') || symlinkEscape(paths.projectRoot, path, []) !== null) throw new Error('Decision source escapes workspace');
      sourceVersions[row.path] = existsSync(path) ? progressHash(readFileSync(path, 'utf8')) : 'missing';
    }
    const task = state?.requests ?? [];
    // Full stage-specific excerpts live in the question; these hashes are freshness guards, not evidence of shown text.
    return { revision: progressHash({ task, documents, sourceVersions }), task,
      constraints: { stage, documentVersions: Object.fromEntries(Object.entries(documents).map(([key, value]) => [key, progressHash(value)])),
        rule: 'Use only the approved stage scope. Source version hashes do not imply the source text is present. Unknown business decisions require human input.' }, sourceVersions };
  } };
}
