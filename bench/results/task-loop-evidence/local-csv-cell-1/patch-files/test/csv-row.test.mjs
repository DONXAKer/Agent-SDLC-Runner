import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvRow } from '../src/format.mjs';

test('csvRow plain cells', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
});

test('csvRow empty array', () => {
  assert.equal(csvRow([]), '');
});

test('csvRow quotes and doubles quotes', () => {
  assert.equal(csvRow(['a', 'b,c', 'd"e', 'f\ng', 'h\ri', '']), 'a,"b,c","d""e","f\ng","h\ri",');
});

test('csvRow preserves whitespace and unicode, does not mutate', () => {
  const values = ['  x  ', 'café', '日本語'];
  assert.equal(csvRow(values), '  x  ,café,日本語');
  assert.deepEqual(values, ['  x  ', 'café', '日本語']);
});
