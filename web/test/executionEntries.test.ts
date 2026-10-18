import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionEntry } from '@sdlc-runner/shared';
import { mergeExecutionEntries, filterExecutionEntries } from '../src/lib/executionEntries.ts';
const entry=(id:string,attempt=1):ExecutionEntry=>({id,at:'',invocation:'stage-1',stage:'chunk',kind:'execution_operation',from:'runtime',to:'runtime',payload:{parentId:'parent'},itemId:'unit',attempt});
test('live history reconnect deduplicates and bounds a large journal',()=>{
  const previous=Array.from({length:2100},(_,i)=>entry(String(i)));
  const merged=mergeExecutionEntries(previous,[entry('2099'),entry('2100')]);
  assert.equal(merged.length,2000); assert.equal(merged.at(-1)?.id,'2100'); assert.equal(new Set(merged.map(e=>e.id)).size,2000);
});
test('filters preserve parent evidence and do not conflate attempts',()=>{
  const entries=[entry('a'),entry('b',2)];
  assert.deepEqual(filterExecutionEntries(entries,{text:'PARENT',stage:'chunk',item:'unit',attempt:'2'}).map(e=>e.id),['b']);
  assert.equal(filterExecutionEntries(entries,{text:'',stage:'plan',item:'',attempt:''}).length,0);
});
