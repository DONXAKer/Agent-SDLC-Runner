import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export async function verifyBehavior(root){const api=await import(pathToFileURL(root+'/src/index.ts').href);const transport=api.memoryTransport();const msg={to:'recipient',text:'hello',phone:'+71234567890'};
 const first=api.sendNotification(transport,msg,{idempotencyKey:'contract-key'});assert.equal(api.sendNotification(transport,{...msg},{idempotencyKey:'contract-key'}),first);assert.equal(transport.sent.length,1);
 for(const field of ['to','text','phone'])assert.throws(()=>api.sendNotification(transport,{...msg,[field]:'different'},{idempotencyKey:'contract-key'}));
 const a=api.sendNotification(transport,msg),b=api.sendNotification(transport,msg);assert.notEqual(a,b);assert.equal(transport.sent.length,3);
}
export function verifyExistingTests(root,baseline){for(const[file,text]of Object.entries(baseline))assert.equal(fs.readFileSync(root+'/'+file,'utf8'),text,file);}
