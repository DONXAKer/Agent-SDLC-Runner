import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveOptions} from '../src/options.mjs';

test('resolveOptions merges known keys with override', () => {
  const base = {a: 1, b: 2};
  const override = {b: 3, c: 4};
  const result = resolveOptions(base, override);

  assert.deepEqual(result, {a: 1, b: 3, c: 4});
  assert.notEqual(result, base);
  assert.notEqual(result, override);
  // inputs are not mutated
  assert.deepEqual(base, {a: 1, b: 2});
  assert.deepEqual(override, {b: 3, c: 4});
});

test('resolveOptions preserves null, false, zero and empty string', () => {
  const base = {a: null, b: false, c: 0, d: ''};
  const override = {a: 1, b: 2, c: 3, d: 4};
  const result = resolveOptions(base, override);
  assert.deepEqual(result, {a: 1, b: 2, c: 3, d: 4});

  const kept = resolveOptions(base, {});
  assert.deepEqual(kept, {a: null, b: false, c: 0, d: ''});
});

test('resolveOptions drops undefined override values not present in base', () => {
  const base = {a: 1};
  const override = {a: undefined, b: undefined};
  const result = resolveOptions(base, override);
  assert.deepEqual(result, {a: 1});
});

test('resolveOptions keeps base values for undefined override keys', () => {
  const base = {a: 1, b: 2};
  const override = {a: undefined, c: 3};
  const result = resolveOptions(base, override);
  assert.deepEqual(result, {a: 1, b: 2, c: 3});
});

test('resolveOptions ignores inherited keys', () => {
  const base = {a: 1};
  const inheritedBase = Object.create({inheritedBase: 'x'});
  Object.assign(inheritedBase, {a: 1});
  const override = Object.create({inheritedOverride: 'y'});
  Object.assign(override, {b: 2});

  const result = resolveOptions(inheritedBase, override);
  assert.deepEqual(result, {a: 1, b: 2});
  assert.equal('inheritedBase' in result, false);
  assert.equal('inheritedOverride' in result, false);
});

test('resolveOptions returns a new object and never mutates inputs', () => {
  const base = {a: 1};
  const override = {b: 2};
  const result = resolveOptions(base, override);
  assert.notEqual(result, base);
  assert.notEqual(result, override);
  assert.deepEqual(base, {a: 1});
  assert.deepEqual(override, {b: 2});
  assert.deepEqual(result, {a: 1, b: 2});
});
