import {test} from 'node:test';
import assert from 'node:assert/strict';
import {csvRow} from '../src/format.mjs';

test('csvRow with empty array returns empty string', () => {
  assert.equal(csvRow([]), '');
});

test('csvRow with simple values', () => {
  assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
});

test('csvRow with empty cells', () => {
  assert.equal(csvRow(['a', '', 'c']), 'a,,c');
});

test('csvRow with comma in cell', () => {
  assert.equal(csvRow(['a', 'b,c', 'd']), 'a,"b,c",d');
});

test('csvRow with double quote in cell', () => {
  assert.equal(csvRow(['a', 'b"c', 'd']), 'a,"b""c",d');
});

test('csvRow with newline in cell', () => {
  assert.equal(csvRow(['a', 'b\nc', 'd']), 'a,"b\nc",d');
});

test('csvRow with carriage return in cell', () => {
  assert.equal(csvRow(['a', 'b\rc', 'd']), 'a,"b\rc",d');
});

test('csvRow with whitespace', () => {
  assert.equal(csvRow([' a ', ' b ', ' c ']), ' a , b , c ');
});

test('csvRow with unicode', () => {
  assert.equal(csvRow(['α', 'β', 'γ']), 'α,β,γ');
});