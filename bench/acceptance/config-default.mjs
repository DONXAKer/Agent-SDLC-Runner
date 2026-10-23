import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export async function verifyBehavior(root){const api=await import(pathToFileURL(root+'/src/index.ts').href);const customer={name:'Example',email:'u@h.example',phone:'81234567890'};
 for(const [config,opts,value]of [[undefined,undefined,14],[{defaultDueDays:21},undefined,21],[{defaultDueDays:21},{dueDays:3},3],[undefined,{dueDays:0},0]])assert.equal(api.bill('A',customer,[],config,opts).dueDays,value);
 assert.match(fs.readFileSync(root+'/README.md','utf8'),/defaultDueDays/);
 const source=fs.readFileSync(root+'/src/invoice.ts','utf8');assert.match(source,/resolveConfig/);assert.doesNotMatch(source,/DEFAULT_CONFIG/);
}
export function verifyExistingTests(root,baseline){for(const [file,text]of Object.entries(baseline)){const current=fs.readFileSync(root+'/'+file,'utf8');if(file!=='test/invoice.test.ts')assert.equal(current,text,file);else{assert.ok(current.includes('dueDays'));assert.ok(current.includes('subtotal'));assert.ok(current.includes('total'));}}}
