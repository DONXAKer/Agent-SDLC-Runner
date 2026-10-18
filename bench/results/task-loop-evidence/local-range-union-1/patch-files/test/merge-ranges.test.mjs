import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeRanges, protocolVersion} from '../src/ranges.mjs';

test('protocolVersion preserved', ()=>assert.equal(protocolVersion,1));

test('merges overlapping and touching ranges, sorted', ()=>{
  const input = [[5,6],[1,2],[2,4],[7,10],[1,1],[0,0],[9,11]];
  const out = mergeRanges(input);
  assert.deepEqual(out, [[0,0],[1,4],[5,6],[7,11]]);
});

test('empty input returns []', ()=>{
  assert.deepEqual(mergeRanges([]), []);
});

test('does not mutate input nor share pair arrays', ()=>{
  const a = [1,2];
  const b = [3,4];
  const input = [b, a];
  const out = mergeRanges(input);
  assert.deepEqual(input, [[3,4],[1,2]]);
  assert.ok(!Object.is(out[0], input[0]) && !Object.is(out[1], input[1]));
  out[0][1] = 999;
  assert.deepEqual(input, [[3,4],[1,2]]);
});

test('throws TypeError on invalid pairs and nonfinite numbers', ()=>{
  assert.throws(()=>mergeRanges([[1]]), TypeError);
  assert.throws(()=>mergeRanges([[2,1]]), TypeError);
  assert.throws(()=>mergeRanges([[1/0, 2]]), TypeError);
  assert.throws(()=>mergeRanges([[1, NaN]]), TypeError);
  assert.throws(()=>mergeRanges([[ '1', 2 ]]), TypeError);
  assert.throws(()=>mergeRanges('nope'), TypeError);
});
