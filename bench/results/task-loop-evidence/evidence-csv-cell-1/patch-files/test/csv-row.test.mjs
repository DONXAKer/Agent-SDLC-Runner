import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow} from '../src/format.mjs';

test('csvRow joins plain cells with commas, no trailing newline', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
});

test('csvRow quotes cells containing comma, double quote, CR or LF', () => {
  assert.equal(csvRow(['a,b', 'c"d', 'e\rf', 'g\nh']), '"a,b","c""d","e\rf","g\nh"');
});

test('csvRow doubles each embedded double quote', () => {
  assert.equal(csvRow(['say "hi" "again"']), '"say ""hi"" ""again"""');
});

test('csvRow preserves whitespace and Unicode exactly', () => {
  const values = ['  padded  ', 'café', '日本語', '\t'];
  assert.equal(csvRow(values), '  padded  ,café,日本語,\t');
});

test('csvRow keeps empty cells exactly', () => {
  assert.equal(csvRow(['a', '', 'b']), 'a,,b');
  assert.equal(csvRow(['']), '');
});

test('csvRow returns empty string for empty array', () => {
  assert.equal(csvRow(['']), '');
  assert.equal(csvRow([]), '');
});

test('csvRow does not mutate input values', () => {
  const values = ['a,b', 'c"d', 'plain'];
  const copy = [...values];
  csvRow(values);
  assert.deepEqual(values, copy);
});
