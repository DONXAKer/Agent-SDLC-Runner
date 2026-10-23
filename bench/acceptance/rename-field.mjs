import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export async function verifyBehavior(root){const api=await import(pathToFileURL(root+'/src/index.ts').href);const p=api.product('SKU-7','Example',321);
 assert.equal(p.sku,'SKU-7');assert.equal('code'in p,false);const text=api.serialize(p);assert.deepEqual(api.parse(text),p);
 const row=JSON.parse(text);assert.equal(row.sku,'SKU-7');assert.equal('code'in row,false);assert.equal(Object.keys(row)[0],'sku');
 assert.equal(api.parse(JSON.stringify({code:'OLD',title:'Example',priceK:321})).sku,'OLD');
 assert.equal(api.parse(JSON.stringify({code:'OLD',sku:'NEW',title:'Example',priceK:321})).sku,'NEW');
 assert.match(fs.readFileSync(root+'/README.md','utf8'),/sku/);
}
export function verifyExistingTests(root,baseline){for(const[file,text]of Object.entries(baseline))assert.equal(fs.readFileSync(root+'/'+file,'utf8'),text,file);}
