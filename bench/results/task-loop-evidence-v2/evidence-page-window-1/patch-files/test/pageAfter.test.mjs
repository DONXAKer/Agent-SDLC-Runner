import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protocolVersion, pageAfter} from '../src/page.mjs';

const items = [
  {id: 'a', name: 'alpha'},
  {id: 'b', name: 'beta'},
  {id: 'c', name: 'gamma'},
  {id: 'd', name: 'delta'},
];

test('protocolVersion preserved', () => {
  assert.equal(protocolVersion, 1);
});

test('null cursor starts at first item', () => {
  const result = pageAfter(items, null, 2);
  assert.deepEqual(result.items, items.slice(0, 2));
  assert.equal(result.nextCursor, 'b');
});

test('known cursor starts after that item', () => {
  const result = pageAfter(items, 'b', 2);
  assert.deepEqual(result.items, items.slice(2));
  assert.deepStrictEqual(result.items[0].id, 'c');
  assert.equal(result.nextCursor, null);
});

test('page beyond end returns empty page with null cursor', () => {
  const result = pageAfter(items, 'd', 2);
  assert.deepEqual(result.items, []);
  assert.equal(result.nextCursor, null);
});

test('unknown cursor throws RangeError', () => {
  assert.throws(() => pageAfter(items, 'zzz', 2), RangeError);
});

test('invalid limit throws RangeError', () => {
  assert.throws(() => pageAfter(items, null, 0), RangeError);
  assert.throws(() => pageAfter(items, null, 101), RangeError);
  assert.throws(() => pageAfter(items, null, 1.5), RangeError);
  assert.throws(() => pageAfter(items, null, '5'), RangeError);
  assert.throws(() => pageAfter(items, null, undefined), RangeError);
});

test('does not mutate inputs', () => {
  const snapshot = items.map((item) => ({...item}));
  const page = items.slice();
  pageAfter(items, 'a', 2);
  assert.deepEqual(items, snapshot);
});

test('full list returned as one page', () => {
  const result = pageAfter(items, null, 100);
  assert.equal(result.items.length, 4);
  assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.equal(result.nextCursor, null);
});
