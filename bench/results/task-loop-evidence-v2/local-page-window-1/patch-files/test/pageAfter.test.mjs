import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageAfter } from '../src/page.mjs';

const items = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
];

test('starts at first item when cursor is null', () => {
  assert.deepEqual(pageAfter(items, null, 2), {
    items: [{ id: 'a' }, { id: 'b' }],
    nextCursor: 'b',
  });
});

test('starts after a known cursor', () => {
  assert.deepEqual(pageAfter(items, 'b', 2), {
    items: [{ id: 'c' }, { id: 'd' }],
    nextCursor: null,
  });
});

test('throws RangeError for unknown cursor', () => {
  assert.throws(() => pageAfter(items, 'zzz', 2), RangeError);
});

test('limit out of range throws RangeError', () => {
  assert.throws(() => pageAfter(items, null, 0), RangeError);
  assert.throws(() => pageAfter(items, null, 101), RangeError);
  assert.throws(() => pageAfter(items, null, 1.5), RangeError);
});

test('empty input returns empty page with null cursor', () => {
  assert.deepEqual(pageAfter([], null, 5), { items: [], nextCursor: null });
});

test('last cursor on exhausted tail returns empty page', () => {
  assert.deepEqual(pageAfter(items, 'd', 3), { items: [], nextCursor: null });
});

test('does not mutate inputs', () => {
  const source = [{ id: 'x' }, { id: 'y' }];
  const copy = source.map((i) => ({ ...i }));
  pageAfter(source, null, 1);
  assert.deepEqual(source, copy);
});

test('preserves input order and unique ids', () => {
  const result = pageAfter(items, null, 100);
  assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.equal(result.nextCursor, null);
});
