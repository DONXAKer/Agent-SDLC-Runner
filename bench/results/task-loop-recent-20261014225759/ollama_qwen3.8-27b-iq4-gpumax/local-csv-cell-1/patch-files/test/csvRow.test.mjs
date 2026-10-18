import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow} from '../src/format.mjs';

test('csvRow separators and quoting', () => {
  assert.equal(csvRow([]), '');
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
  assert.equal(csvRow(['with,comma']), '"with,comma"');
  assert.equal(csvRow(['with"quote']), '"with""quote"');
  assert.equal(csvRow(['has,both"'],), '"has,both"""');
  assert.equal(csvRow(['cr\rhere']), '"cr\rhere"');
  assert.equal(csvRow(['lf\nhere']), '"lf\nhere"');
  assert.equal(csvRow(['  spaces  ']), '  spaces  ');
  assert.equal(csvRow(['', 'mid', '']), ',mid,');
  assert.equal(csvRow(['日本語', '日本語,with,comma']), '日本語,"日本語,with,comma"');
});

test('csvRow does not mutate input', () => {
  const values = ['plain', 'quoted"', 'comma,'];
  const copy = [...values];
  csvRow(values);
  assert.deepEqual(values, copy);
});
