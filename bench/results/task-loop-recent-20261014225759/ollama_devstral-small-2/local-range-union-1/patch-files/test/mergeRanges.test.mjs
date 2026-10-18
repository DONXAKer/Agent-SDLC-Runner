import  {test} from  'node:test'; import assert from  'node:assert/strict'; import  {mergeRanges} from  '../src/ranges.mjs';

test('mergeRanges  - basic merging', () => {
  const result  = mergeRanges([[1,3],[2,6],[8,10],[15,18]]);
  assert.deepStrictEqual(result, [[1,6],[8,10],[15,18]]);
});

test('mergeRanges  - touching ranges', () => {
  const result  = mergeRanges([[1,2],[2,3],[3,4]]);
  assert.deepStrictEqual(result, [[1,4]]);
});

test('mergeRanges  - empty array', () => {
  const result  = mergeRanges([]);
  assert.deepStrictEqual(result, []);
});

test('mergeRanges  - already merged', () => {
  const result  = mergeRanges([[1,2],[3,4],[5,6]]);
  assert.deepStrictEqual(result, [[1,2],[3,4],[5,6]]);
});

test('mergeRanges  - single range', () => {
  const result  = mergeRanges([[1,5]]);
  assert.deepStrictEqual(result, [[1,5]]);
});

test('mergeRanges  - non-finite numbers', () => {
  assert.throws(() => mergeRanges([[1,2],[NaN,4]]), TypeError);
  assert.throws(() => mergeRanges([[1,2],[Infinity,4]]), TypeError);
  assert.throws(() => mergeRanges([[1,2],[-Infinity,4]]), TypeError);
});

test('mergeRanges  - reversed endpoints', () => {
  assert.throws(() => mergeRanges([[5,1],[2,6]]), TypeError);
});

test('mergeRanges  - invalid range format', () => {
  assert.throws(() => mergeRanges([[1,2,3],[2,6]]), TypeError);
  assert.throws(() => mergeRanges([[1],[2,6]]), TypeError);
  assert.throws(() => mergeRanges(['not array',[2,6]]), TypeError);
});

test('mergeRanges  - does not mutate input', () => {
  const input  = [[1,3],[2,6],[8,10]];
  const original  = JSON.stringify(input);
  mergeRanges(input);
  assert.equal(JSON.stringify(input), original);
});

test('mergeRanges  - does not share references', () => {
  const input  = [[1,3],[2,6],[8,10]];
  const result  = mergeRanges(input);
  
  // Modify the result and ensure input is unchanged
  result[0][0]  = 999;
  assert.notEqual(input[0][0], 999);
  assert.equal(input[0][0], 1);
});
