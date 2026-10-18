import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow, protocolVersion} from '../src/format.mjs';

test('csvRow: empty array returns empty string', () => {
  assert.equal(csvRow([]), '');
});

test('csvRow: plain cells joined by commas, no trailing newline', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
  assert.equal(csvRow(['hello']), 'hello');
});

test('csvRow: quotes cells containing comma, quote, CR, LF', () => {
  assert.equal(csvRow(['a,b']), '"a,b"');
  assert.equal(csvRow(['say "hi"']), '"say ""hi"""');
  assert.equal(csvRow(['a\rb']), '"a\rb"');
  assert.equal(csvRow(['a\nb']), '"a\nb"');
});

test('csvRow: doubles embedded quotes only when quoting', () => {
  assert.equal(csvRow(['plain', 'x"y']), 'plain,"x""y"');
});

test('csvRow: preserves whitespace and unicode exactly', () => {
  assert.equal(csvRow(['  spaced  ', 'ünïcødé', '日本語', '🚀 emoji']), '  spaced  ,ünïcødé,日本語,🚀 emoji');
});

test('csvRow: empty cells stay empty', () => {
  assert.equal(csvRow(['', 'a', '']), ',a,');
});

test('csvRow: does not mutate input', () => {
  const input = ['a,b', 'x"y', '\n'];
  const copy = [...input];
  csvRow(input);
  assert.deepEqual(input, copy);
});

test('existing export preserved', () => {
  assert.equal(protocolVersion, 1);
});
