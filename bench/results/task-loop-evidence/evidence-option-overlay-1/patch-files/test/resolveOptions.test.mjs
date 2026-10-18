import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveOptions, protocolVersion} from '../src/options.mjs';

test('protocolVersion still exported', () => {
  assert.equal(protocolVersion, 1);
});

test('shallow-merges override onto base', () => {
  assert.deepEqual(resolveOptions({a: 1, b: 2}, {b: 3, c: 4}), {a: 1, b: 3, c: 4});
});

test('undefined override values keep base values', () => {
  assert.deepEqual(resolveOptions({a: 1, b: 2}, {b: undefined, c: undefined}), {a: 1, b: 2});
});

test('undefined override keys absent from base are omitted', () => {
  assert.deepEqual(resolveOptions({a: 1}, {b: undefined}), {a: 1});
});

test('preserves null, false, zero and empty string as explicit overrides', () => {
  assert.deepEqual(
    resolveOptions({a: 1, b: 2, c: 3, d: 4}, {a: null, b: false, c: 0, d: ''}),
    {a: null, b: false, c: 0, d: ''}
  );
});

test('returns a new object and never mutates inputs', () => {
  const base = {a: 1};
  const override = {b: 2};
  const result = resolveOptions(base, override);
  assert.notStrictEqual(result, base);
  assert.notStrictEqual(result, override);
  assert.deepEqual(base, {a: 1});
  assert.deepEqual(override, {b: 2});
});

test('ignores inherited keys on both inputs', () => {
  function Base() {}
  Base.prototype.inherited = 'x';
  const base = Object.create(Base.prototype);
  base.own = 1;
  function Override() {}
  Override.prototype.inherited = 'y';
  const override = Object.create(Override.prototype);
  override.extra = 2;
  assert.deepEqual(resolveOptions(base, override), {own: 1, extra: 2});
});

test('handles empty inputs', () => {
  assert.deepEqual(resolveOptions({}, {}), {});
  const base = {};
  assert.deepEqual(resolveOptions(base, {}), {});
  assert.equal(Object.keys(base).length, 0);
});

test('override can add keys not present in base', () => {
  assert.deepEqual(resolveOptions({}, {a: 1}), {a: 1});
});
