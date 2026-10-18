import {test} from 'node:test'; import assert from 'node:assert/strict'; import {splitCents} from '../src/shares.mjs';

test('split sum and diff invariant', ()=>{
  const total=10001,count=3;
  const s=splitCents(total,count);
  assert.equal(s.length,count);
  assert.ok(s.every(Number.isInteger));
  assert.equal(s.reduce((a,b)=>a+b,0),total);
  const min=Math.min(...s),max=Math.max(...s);
  assert.ok(max-min<=1);
  assert.deepEqual(s,[3334,3334,3333]);
});

test('extra cents go to earliest indices', ()=>{
  assert.deepEqual(splitCents(10,3),[4,3,3]);
});

test('edge cases', ()=>{
  assert.deepEqual(splitCents(0,5),[0,0,0,0,0]);
  assert.deepEqual(splitCents(1,1000),[...Array(1000).keys()].map(i=>i===0?1:0));
  const big=splitCents(Number.MAX_SAFE_INTEGER,2);
  assert.equal(big.reduce((a,b)=>a+b,0),Number.MAX_SAFE_INTEGER);
});

test('invalid inputs throw RangeError', ()=>{
  for(const args of [[-1,1],[1.5,1],[NaN,1],[Number.MAX_SAFE_INTEGER+2,2],[1,0],[1,-1],[1,1001],[1,1.5],[1,NaN]])
    assert.throws(()=>splitCents(...args),RangeError);
});
