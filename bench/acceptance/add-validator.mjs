import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export async function verifyBehavior(root){
 const api=await import(pathToFileURL(root+'/src/index.ts').href);assert.equal(typeof api.validateCustomer,'function');
 assert.ok(fs.existsSync(root+'/src/validate.ts'));
 const good={name:'Example',email:'user@host.example',phone:'+71234567890'};
 for(const [email,bad] of [['a@b.c',false],['a@@b.c',true],['@b.c',true],['a@b',true],['a@.b',true],['a@b.',true],['a b@c.d',true],['a@b.c ',true]])assert.deepEqual(api.validateCustomer({...good,email}),bad?['email']:[]);
 for(const [phone,bad] of [['81234567890',false],['+7123456789',true],['812345678901',true],['+7 1234567890',true],['+7(123)456-7890',true],['91234567890',true]])assert.deepEqual(api.validateCustomer({...good,phone}),bad?['phone']:[]);
 assert.deepEqual(api.validateCustomer({...good,email:'bad',phone:'bad'}),['email','phone']);
 const frozen=Object.freeze({...good});assert.deepEqual(api.validateCustomer(frozen),[]);assert.deepEqual(frozen,good);
}
export function verifyExistingTests(root,baseline){for(const [file,text]of Object.entries(baseline))assert.equal(fs.readFileSync(root+'/'+file,'utf8'),text,file);}
