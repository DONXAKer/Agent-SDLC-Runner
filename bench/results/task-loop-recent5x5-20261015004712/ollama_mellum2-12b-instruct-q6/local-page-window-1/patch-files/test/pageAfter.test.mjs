import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageAfter} from '../src/page.mjs';

test('pageAfter with null cursor', () => {
  const items = [
    {id: '1', name: 'Item 1'},
    {id: '2', name: 'Item 2'},
    {id: '3', name: 'Item 3'}
  ];
  
  const result = pageAfter(items, null, 2);
  
  assert.deepStrictEqual(result, {
    items: [
      {id: '1', name: 'Item 1'},
      {id: '2', name: 'Item 2'}
    ],
    nextCursor: '2'
  });
});

test('pageAfter with known cursor', () => {
  const items = [
    {id: '1', name: 'Item 1'},
    {id: '2', name: 'Item 2'},
    {id: '3', name: 'Item 3'}
  ];
  
  const result = pageAfter(items, '1', 2);
  
  assert.deepStrictEqual(result, {
    items: [
      {id: '2', name: 'Item 2'},
      {id: '3', name: 'Item 3'}
    ],
    nextCursor: null
  });
});

test('pageAfter with limit at end', () => {
  const items = [
    {id: '1', name: 'Item 1'},
    {id: '2', name: 'Item 2'}
  ];
  
  const result = pageAfter(items, null, 5);
  
  assert.deepStrictEqual(result, {
    items: [
      {id: '1', name: 'Item 1'},
      {id: '2', name: 'Item 2'}
    ],
    nextCursor: null
  });
});

test('pageAfter throws RangeError for invalid limit', () => {
  const items = [
    {id: '1', name: 'Item 1'},
    {id: '2', name: 'Item 2'}
  ];
  
  assert.throws(() => pageAfter(items, null, 0), RangeError);
  assert.throws(() => pageAfter(items, null, 101), RangeError);
  assert.throws(() => pageAfter(items, null, 1.5), RangeError);
});

test('pageAfter throws RangeError for unknown cursor', () => {
  const items = [
    {id: '1', name: 'Item 1'},
    {id: '2', name: 'Item 2'}
  ];
  
  assert.throws(() => pageAfter(items, '3', 2), RangeError);
});