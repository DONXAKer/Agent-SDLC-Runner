import { strict as assert } from 'assert';
import { pageAfter } from '../src/page.mjs';

const items = [
  { id: 'a', val: 1 },
  { id: 'b', val: 2 },
  { id: 'c', val: 3 },
  { id: 'd', val: 4 },
];

// Helper to deep-freeze items to detect mutation
const deepFreeze = obj => {
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    if (obj[key] && typeof obj[key] === 'object') deepFreeze(obj[key]);
  }
};

// Freeze items array and its objects
items.forEach(deepFreeze);
deepFreeze(items);

// Test default paging from start
let result = pageAfter(items, null, 2);
assert.deepEqual(result.items, [items[0], items[1]], 'page items correct from start');
assert.equal(result.nextCursor, 'b', 'nextCursor correct after first page');

// Test paging after known cursor
result = pageAfter(items, 'b', 2);
assert.deepEqual(result.items, [items[2], items[3]], 'page items correct after cursor');
assert.equal(result.nextCursor, null, 'nextCursor null when no more items');

// Test when limit exceeds remaining items
result = pageAfter(items, 'b', 5);
assert.deepEqual(result.items, [items[2], items[3]], 'returns remaining items when limit too big');
assert.equal(result.nextCursor, null, 'nextCursor null when list exhausted');

// Test unknown cursor throws
assert.throws(() => pageAfter(items, 'x', 2), RangeError, 'unknown cursor throws');

// Test invalid limit throws
assert.throws(() => pageAfter(items, null, 0), RangeError, 'limit 0 throws');
assert.throws(() => pageAfter(items, null, 101), RangeError, 'limit >100 throws');

console.log('All page.mjs tests passed');
