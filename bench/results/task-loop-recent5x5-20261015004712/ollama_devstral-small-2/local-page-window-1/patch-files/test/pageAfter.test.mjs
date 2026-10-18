import  { test } from  'node:test'; 
import  assert from  'node:assert/strict';
import  { pageAfter, protocolVersion } from  '../src/page.mjs';

test('pageAfter  - basic pagination', () => {
  const items  = [
    { id: '1', name: 'First' },
    { id: '2', name: 'Second' },
    { id: '3', name: 'Third' },
    { id: '4', name: 'Fourth' },
    { id: '5', name: 'Fifth' }
  ];
  
  // First page
  let result  = pageAfter(items, null, 2);
  assert.deepStrictEqual(result.items, [items[0], items[1]]);
  assert.strictEqual(result.nextCursor, '2');
  
  // Second page using cursor
  result  = pageAfter(items, '2', 2);
  assert.deepStrictEqual(result.items, [items[2], items[3]]);
  assert.strictEqual(result.nextCursor, '4');
  
  // Last page
  result  = pageAfter(items, '4', 2);
  assert.deepStrictEqual(result.items, [items[4]]);
  assert.strictEqual(result.nextCursor, null);
});

test('pageAfter  - limit validation', () => {
  const items  = [{ id: '1' }];
  
  // Test limits outside valid range
  assert.throws(() => pageAfter(items, null, 0), RangeError);
  assert.throws(() => pageAfter(items, null, 101), RangeError);
  assert.throws(() => pageAfter(items, null, 1.5), RangeError);
  assert.throws(() => pageAfter(items, null, '5'), RangeError);
});

test('pageAfter  - cursor validation', () => {
  const items  = [{ id: '1' }, { id: '2' }, { id: '3' }];
  
  // Unknown cursor should throw
  assert.throws(() => pageAfter(items, 'unknown', 2), RangeError);
  assert.throws(() => pageAfter(items, '4', 2), RangeError);
});

test('pageAfter  - empty result sets', () => {
  const items  = [{ id: '1' }];
  
  // Request more items than available
  let result  = pageAfter(items, null, 10);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.nextCursor, null);
  
  // Cursor beyond all items
  result  = pageAfter(items, '1', 10);
  assert.strictEqual(result.items.length, 0);
  assert.strictEqual(result.nextCursor, null);
});

test('pageAfter  - order preservation', () => {
  const items  = [
    { id: 'c', name: 'Third' },
    { id: 'a', name: 'First' },
    { id: 'b', name: 'Second' }
  ];
  
  // Using known cursor should maintain original order
  const result  = pageAfter(items, 'a', 2);
  assert.deepStrictEqual(result.items, [items[2]]); // 'b' comes after 'a' in original order
});

test('existing public API', () => {
  assert.equal(protocolVersion, 1);
});
