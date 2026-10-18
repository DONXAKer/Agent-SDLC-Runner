import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow} from '../src/format.mjs';

// Basic functionality test
const checkCSVRow = (input, expected) => {
  test(`csvRow(${JSON.stringify(input)}) = "${expected.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`, () => {
    assert.deepEqual(csvRow(input), expected);
  });
};

checkCSVRow([], '');
checkCSVRow(['foo', 'bar', 'baz'], 'foo,bar,baz');
checkCSVRow(['simple'], 'simple');
checkCSVRow(['empty', '', 'also empty'], 'empty,,also empty');

// Edge cases
checkCSVRow(['quoted', 'with " quotes'], 'quoted,with "" quotes');
checkCSVRow(['field with comma', 'no comma'], '"field with comma",no comma');
checkCSVRow(['newline\r\n', 'carriage '], '"newline\r\n",carriage ');

// Unicode
checkCSVRow(['中文 cell', 'Hello'], '中文 cell,Hello');
// whitespace
checkCSVRow(['  space  leading', 'trailing  '], '  space  leading,trailing  ');
// Embedded line breaks
checkCSVRow(['line1\nline2'], '"line1\nline2"');