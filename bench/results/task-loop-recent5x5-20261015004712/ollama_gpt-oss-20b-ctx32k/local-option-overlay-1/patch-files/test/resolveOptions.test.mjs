import {test} from 'node:test'; import assert from 'node:assert/strict'; import {resolveOptions} from '../src/options.mjs';

test('resolveOptions merges overrides correctly', () => {
  const base = {a: 1, b: 2};
  const override = {b: 3, c: 4};
  const res = resolveOptions(base, override);
  assert.deepEqual(res, {a: 1, b: 3, c: 4});
});

test('override undefined retains base value', () => {
  const base = {a: 1, b: 2};
  const override = {a: undefined};
  const res = resolveOptions(base, override);
  assert.deepEqual(res, {a: 1, b: 2});
});

test('override undefined for new key omitted', () => {
  const base = {a: 1};
  const override = {b: undefined};
  const res = resolveOptions(base, override);
  assert.deepEqual(res, {a: 1});
});

test('override null, false, zero, empty string preserved', () => {
  const base = {a: 1};
  const override = {a: null, b: false, c: 0, d: ''};
  const res = resolveOptions(base, override);
  assert.deepEqual(res, {a: null, b: false, c: 0, d: ''});
});

// Test that __proto__ becomes own property

test('__proto__ handled as own property', () => {
  const base = {};
  const override = {'__proto__': {test: 42}};
  const res = resolveOptions(base, override);
  assert.deepEqual(res, {'__proto__': {test: 42}});
  // ensure not prototype
  assert.notStrictEqual(Object.getPrototypeOf(res), {test:42});
});
