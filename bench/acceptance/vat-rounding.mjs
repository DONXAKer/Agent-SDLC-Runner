import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export async function verifyBehavior(root){const api=await import(pathToFileURL(root+'/src/index.ts').href);assert.ok(fs.existsSync(root+'/src/vat.ts'));const customer={name:'Example',email:'u@h.example',phone:'81234567890'};
 for(const amount of [0,1,2,3,7,333,1001]){const lines=[{title:'Item',qty:1,priceK:amount}],noTax=api.bill('A',customer,lines);assert.equal('vat'in noTax,false);assert.equal(noTax.total,amount);
 const invoice=api.bill('A',customer,lines,undefined,{vat:'std'});assert.equal(invoice.vat,Math.floor(amount*20/100+0.5));assert.equal(invoice.total,amount+invoice.vat);}
}
export function verifyExistingTests(root,baseline){for(const[file,text]of Object.entries(baseline))assert.equal(fs.readFileSync(root+'/'+file,'utf8'),text,file);}
