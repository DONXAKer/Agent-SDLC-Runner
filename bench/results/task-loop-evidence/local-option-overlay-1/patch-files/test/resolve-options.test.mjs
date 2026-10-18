import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptions } from '../src/options.mjs';

test('shallow-merges override into base', () => {
  assert.deepEqual(
    resolveOptions({ a: 1, b: 2 }, { b: 3, c: 4 }),
    { a: 1, b: 3, c: 4 }
  );
});

test('undefined override values keep base values', () => {
  assert.deepEqual(
    resolveOptions({ a: 1, b: 2 }, { b: undefined, c: undefined }),
    { a: 1, b: 2 }
  );
});

test('undefined keys absent from base are omitted', () => {
  assert.deepEqual(resolveOptions({}, { a: undefined, b: 1 }), { b: 1 });
});

test('null, false, zero and empty string are preserved', () => {
  assert.deepEqual(
    resolveOptions({ a: 0, b: '', c: false, d: null }, { a: undefined }),
    { a: 0, b: '', c: false, d: null }
  );
  assert.deepEqual(
    resolveOptions({}, { a: 0, b: '', c: false, d: null }),
    { a: 0, b: '', c: false, d: null }
  );
});

test('returns a new object and never mutates inputs', () => {
  const base = { a: 1 };
  const override = { b: 2 };
  const result = resolveOptions(base, override);
  assert.notStrictEqual(result, base);
  assert.notStrictEqual(result, override);
  assert.deepEqual(base, { a: 1 });
  assert.deepEqual(override, { b: 2 });
});

test('inherited keys are ignored', () => {
  const baseProto = { inheritedBase: 'base' };
  const overrideProto = { inheritedOverride: 'override' };
  const base = Object.create(baseProto, { a: { value: 1, enumerable: true } });
  const override = Object.create(overrideProto, { b: { value: 2, enumerable: true } });
  assert.deepEqual(resolveOptions(base, override), { a: 1, b: 2 });
});
