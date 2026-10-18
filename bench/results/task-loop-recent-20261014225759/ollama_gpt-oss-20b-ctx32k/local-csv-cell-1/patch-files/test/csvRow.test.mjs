import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvRow } from '../src/format.mjs';

test('csvRow simple', () => {
    assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
});

test('csvRow empty array', () => {
    assert.equal(csvRow([]), '');
});

test('csvRow quoting', () => {
    assert.equal(csvRow(['a,b', '"c"', 'd\n']), '"a,b","""c""","d\n"');
});
