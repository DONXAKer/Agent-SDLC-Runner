import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow, protocolVersion} from '../src/format.mjs';

test('csvRow joins plain cells with commas and has no trailing newline', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
});

test('csvRow quotes cells with comma, double quote, CR or LF and doubles quotes', () => {
  assert.equal(csvRow(['a,b']), '"a,b"');
  assert.equal(csvRow(['sa"y']), '"sa""y"');
  assert.equal(csvRow(['cr\rlf\n']), '"cr\rlf\n"');
  assert.equal(csvRow([' "quoted, mix" ']), '" ""quoted, mix"" "');
});

test('csvRow preserves whitespace, unicode and empty cells exactly', () => {
  assert.equal(csvRow(['   ', 'тёст 123', '']), '   ,тёст 123,');
  assert.equal(csvRow(['  pad  ']), '  pad  ');
});

test('csvRow returns empty string for empty array and does not mutate input', () => {
  assert.equal(csvRow([]), '');
  const input = [' raw ', 'x,y'];
  const snapshot = [...input];
  csvRow(input);
  assert.deepEqual(input, snapshot);
});

test('existing exports preserved', () => {
  assert.equal(protocolVersion, 1);
});
