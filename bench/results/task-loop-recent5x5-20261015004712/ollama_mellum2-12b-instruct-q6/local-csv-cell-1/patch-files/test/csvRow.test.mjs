import { csvRow } from '../src/format.mjs';

// Test empty array
console.assert(csvRow([]) === '', 'Empty array should return empty string');

// Test array with simple strings
console.assert(csvRow(['a', 'b', 'c']) === 'a,b,c', 'Simple strings should be joined with commas');

// Test array with empty cells
console.assert(csvRow(['a', '', 'c']) === 'a,,c', 'Empty cells should be preserved');

// Test array with whitespace
console.assert(csvRow(['a', ' b ', 'c']) === 'a, b ,c', 'Whitespace should be preserved');

// Test array with unicode
console.assert(csvRow(['a', '🌟', 'c']) === 'a,🌟,c', 'Unicode should be preserved');

// Test array with comma in cell
console.assert(csvRow(['a', 'b,c', 'd']) === 'a,"b,c",d', 'Comma in cell should be quoted');

// Test array with double quote in cell
console.assert(csvRow(['a', 'b"c', 'd']) === 'a,"b""c",d', 'Double quote in cell should be escaped and quoted');

// Test array with CR in cell
console.assert(csvRow(['a', 'b\rc', 'd']) === 'a,"b\rc",d', 'CR in cell should be quoted');

// Test array with LF in cell
console.assert(csvRow(['a', 'b\nc', 'd']) === 'a,"b\nc",d', 'LF in cell should be quoted');

// Test array with multiple special characters
console.assert(csvRow(['a', 'b,c"d\ne', 'f']) === 'a,"b,c""d\ne",f', 'Multiple special characters should be handled correctly');

console.log('All tests passed!');