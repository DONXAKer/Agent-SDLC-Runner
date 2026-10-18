import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow, protocolVersion} from '../src/format.mjs';

test('csvRow keeps plain cells separated by comma, no trailing newline', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
  assert.equal(csvRow(['x']), 'x');
});

test('csvRow quotes cells with comma, quote, CR or LF and doubles quotes', () => {
  assert.equal(csvRow(['a,b']), '"a,b"');
  assert.equal(csvRow(['say "hi"']), '"say ""hi"""');
  assert.equal(csvRow(['line1\nline2']), '"line1\nline2"');
  assert.equal(csvRow(['cr\rlf']), '"cr\rlf"');
});

test('csvRow preserves whitespace, unicode and empty cells; empty array gives empty string', () => {
  assert.equal(csvRow(['  spaced  ', '', 'é', '日本語', 'tab\there']), '  spaced  ,,é,日本語,tab\there');
  assert.equal(csvRow([]), '');
});

test('csvRow does not mutate its argument', () => {
  const values = ['a,b', 'plain'];
  csvRow(values);
  assert.deepEqual(values, ['a,b', 'plain']);
});

test('existing export preserved', () => {
  assert.equal(protocolVersion, 1);
});
