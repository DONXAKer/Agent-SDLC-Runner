import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protocolVersion, resolveOptions} from '../src/options.mjs';

test('preserves protocolVersion export', () => assert.equal(protocolVersion, 1));

test('shallow-merges override onto base', () => {
  const base = {a: 1, b: 2};
  const override = {b: 3, c: 4};
  const merged = resolveOptions(base, override);
  assert.deepEqual(merged, {a: 1, b: 3, c: 4});
});

test('returns a new object without mutating inputs', () => {
  const base = {a: 1};
  const override = {b: 2};
  const merged = resolveOptions(base, override);
  assert.notEqual(merged, base);
  assert.notEqual(merged, override);
  assert.deepEqual(base, {a: 1});
  assert.deepEqual(override, {b: 2});
  assert.deepEqual(merged, {a: 1, b: 2});
});

test('undefined override values keep base values', () => {
  assert.deepEqual(
    resolveOptions({a: 1, b: 2}, {a: undefined, b: 3}),
    {a: 1, b: 3}
  );
});

test('undefined override keys absent from base are omitted', () => {
  assert.deepEqual(resolveOptions({}, {a: undefined}), {});
  assert.deepEqual(Object.keys(resolveOptions({b: 1}, {a: undefined, b: 2})), ['b']);
});

test('preserves null, false, zero and empty string as explicit values', () => {
  const merged = resolveOptions({a: 1}, {a: null, b: false, c: 0, d: ''});
  assert.equal(merged.a, null);
  assert.equal(merged.b, false);
  assert.equal(merged.c, 0);
  assert.equal(merged.d, '');
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c', 'd']);
});

function ownProtoHolder(value) {
  const obj = {};
  Object.defineProperty(obj, '__proto__', {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return obj;
}

test('"__proto__" becomes an own enumerable property of the result', () => {
  const base = ownProtoHolder({fromBase: true});
  const override = ownProtoHolder({fromOverride: true});
  const merged = resolveOptions(base, override);
  assert.equal(Object.hasOwn(merged, '__proto__'), true);
  const desc = Object.getOwnPropertyDescriptor(merged, '__proto__');
  assert.equal(desc.enumerable, true);
  assert.deepEqual(merged['__proto__'], {fromOverride: true});
  assert.ok(Object.keys(merged).includes('__proto__'));
});

test('inherited keys are ignored', () => {
  const baseParent = {inherited: 'nope'};
  const base = Object.create(baseParent);
  Object.defineProperty(base, 'own', {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const override = Object.create({inheritedOverride: 'nope'});
  Object.defineProperty(override, 'own2', {
    value: 2,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const merged = resolveOptions(base, override);
  assert.deepEqual(Object.keys(merged).sort(), ['own', 'own2']);
  assert.equal(Object.hasOwn(merged, 'inherited'), false);
  assert.equal(Object.hasOwn(merged, 'inheritedOverride'), false);
  assert.deepEqual(merged, {own: 1, own2: 2});
});
