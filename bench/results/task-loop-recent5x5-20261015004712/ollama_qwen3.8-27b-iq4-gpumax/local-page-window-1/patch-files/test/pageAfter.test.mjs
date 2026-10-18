import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageAfter, protocolVersion} from '../src/page.mjs';

const items = [
	{id: 'a'},
	{id: 'b'},
	{id: 'c'},
	{id: 'd'}
];

test('preserves existing export', () => {
	assert.equal(protocolVersion, 1);
});

test('null cursor starts at first item', () => {
	assert.deepEqual(pageAfter(items, null, 2), {items: [{id: 'a'}, {id: 'b'}], nextCursor: 'b'});
});

test('known cursor starts immediately after its item', () => {
	assert.deepEqual(pageAfter(items, 'b', 2), {items: [{id: 'c'}, {id: 'd'}], nextCursor: null});
});

test('unknown cursor throws RangeError', () => {
	assert.throws(() => pageAfter(items, 'z', 2), RangeError);
});

test('invalid limits throw RangeError', () => {
	assert.throws(() => pageAfter(items, null, 0), RangeError);
	assert.throws(() => pageAfter(items, null, 101), RangeError);
	assert.throws(() => pageAfter(items, null, 1.5), RangeError);
	assert.throws(() => pageAfter(items, null, '2'), RangeError);
});

test('limit of 100 or smaller pages work', () => {
	const many = Array.from({length: 150}, (_, i) => ({id: `i${i}`}));
	const first = pageAfter(many, null, 100);
	assert.equal(first.items.length, 100);
	assert.equal(first.nextCursor, 'i99');
	const second = pageAfter(many, 'i99', 100);
	assert.equal(second.items.length, 50);
	assert.equal(second.nextCursor, null);
});

test('does not mutate inputs', () => {
	const snapshot = JSON.parse(JSON.stringify(items));
	pageAfter(items, 'a', 2);
	assert.deepEqual(items, snapshot);
});

test('empty tail returns empty page with null cursor', () => {
	assert.deepEqual(pageAfter(items, 'd', 2), {items: [], nextCursor: null});
});
