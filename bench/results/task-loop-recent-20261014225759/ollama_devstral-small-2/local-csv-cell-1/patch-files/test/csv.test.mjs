import  {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow} from '../src/format.mjs';

test('csvRow simple values without special chars', () => {
  const result = csvRow(['a', 'b', 'c']);
  assert.strictEqual(result, 'a,b,c');
});

test('csvRow with comma', () => {
  const result = csvRow(['hello', 'world,is', 'great']);
  assert.strictEqual(result, 'hello,"world,is",great');
});

test('csvRow with quotes', () => {
  const result = csvRow(['say', '"hello"', 'world']);
  assert.strictEqual(result, 'say,"\"hello\"",world');
});

test('csvRow with line breaks', () => {
  const result = csvRow(['first', 'second\nline', 'third']);
  assert.strictEqual(result, 'first,"second\nline",third');
});

test('csvRow with carriage return', () => {
  const result = csvRow(['first', 'second\rline', 'third']);
  assert.strictEqual(result, 'first,"second\rline",third');
});

test('csvRow with multiple special chars', () => {
  const result = csvRow(['a,b', 'c"d', 'e\nf', 'g\rh']);
  assert.strictEqual(result, '"a,b","c\"d","e\nf","g\rh"');
});

test('csvRow with empty array', () => {
  const result = csvRow([]);
  assert.strictEqual(result, '');
});

test('csvRow with empty string', () => {
  const result = csvRow(['', 'abc', '']);
  assert.strictEqual(result, ',abc,');
});

test('csvRow does not mutate original', () => {
  const original = ['a', 'b', 'c'];
  const originalJson = JSON.stringify(original);
  csvRow(original);
  assert.strictEqual(JSON.stringify(original), originalJson);
});