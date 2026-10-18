import { csvRow } from '../src/format.mjs';

// Test cases for csvRow

// 1. Empty array => ''
console.assert(csvRow([]) === '', 'empty array should produce empty string');

// 2. Simple cells no quoting
console.assert(csvRow(['a','b']) === 'a,b', 'simple cells');

// 3. Cell with comma
console.assert(csvRow(['a,b', 'c']) === '"a,b",c', 'comma quoting');

// 4. Cell with double quote
console.assert(csvRow(['a"b', 'c']) === '"a""b",c', 'quote quoting');

// 5. Cell with newline
console.assert(csvRow(['line\nnext', 'c']) === '"line\nnext",c', 'newline quoting');

// 6. Preserve whitespace
console.assert(csvRow(['  a  ', 'b ']) === '  a  ,b ', 'whitespace unchanged');

// 7. Empty cell
console.assert(csvRow(['', 'b']) === ',b', 'empty cell');

// 8. Unicode
console.assert(csvRow(['☃', '你好']) === '☃,你好', 'unicode');

console.log('csvRow tests passed');
