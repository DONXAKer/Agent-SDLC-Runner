import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveOptions, protocolVersion} from '../src/options.mjs';

test('shallow-merges override into base', () => {
  const base = {a: 1, b: 2};
  const override = {b: 3, c: 4};
  assert.deepEqual(resolveOptions(base, override), {a: 1, b: 3, c: 4});
});

test('does not mutate inputs', () => {
  const base = {a: 1};
  const override = {b: 2};
  resolveOptions(base, override);
  assert.deepEqual(base, {a: 1});
  assert.deepEqual(override, {b: 2});
});

test('returns a new object, not an alias of either input', () => {
  const base = {a: 1};
  const override = {b: 2};
  const out = resolveOptions(base, override);
  assert.notEqual(out, base);
  assert.notEqual(out, override);
});

test('null, false, zero and empty string are explicit values', () => {
  const base = {a: 1, b: false, c: null, d: 0, e: 'x'};
  const override = {a: null, b: false, c: 0, d: '', e: ''};
  assert.deepEqual(resolveOptions(base, override), {a: null, b: false, c: 0, d: '', e: ''});
});

test('explicit values in override can be overwritten with undefined semantics', () => {
  // explicit zero / empty string survive merge
  const base = {a: 5};
  const override = {a: 0};
  assert.deepEqual(resolveOptions(base, override), {a: 0});
});

test('undefined override over existing base key keeps base value', () => {
  const base = {a: 1, b: 'keep'};
  const override = {b: undefined};
  assert.deepEqual(resolveOptions(base, override), {a: 1, b: 'keep'});
});

test('undefined override key absent from base is omitted', () => {
  const base = {a: 1};
  const override = {z: undefined};
  assert.deepEqual(resolveOptions(base, override), {a: 1});
  assert.ok(!('z' in resolveOptions(base, override)));
});

test('inherited (prototype) keys are ignored', () => {
  const base = Object.create({protoKey: 'inherited'});
  base.own = 1;
  const override = Object.create({protoKey2: 'inherited'});
  override.own2 = 2;
  const out = resolveOptions(base, override);
  assert.deepEqual(out, {own: 1, own2: 2});
  assert.ok(!('protoKey' in out));
  assert.ok(!('protoKey2' in out));
});

test('default override is fine', () => {
  const base = {a: 1};
  assert.deepEqual(resolveOptions(base), {a: 1});
});

test('empty inputs yield empty object', () => {
  assert.deepEqual(resolveOptions({}, {}), {});
});

test('protocolVersion still exported (public API preserved)', () => {
  assert.equal(protocolVersion, 1);
});
