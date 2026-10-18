import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from '../src/inventory.mjs';

test('initial stock is copied and available reports counts', () => {
  const initial = { a: 5, b: 0 };
  const inv = createInventory(initial);
  initial.a = 99;
  assert.equal(inv.available('a'), 5);
  assert.equal(inv.available('b'), 0);
  assert.equal(inv.available('zzz'), 0);
});

test('reserve subtracts and returns token; release restores once', () => {
  const inv = createInventory({ a: 10 });
  const t1 = inv.reserve('a', 3);
  assert.ok(t1 !== null);
  assert.equal(inv.available('a'), 7);
  assert.equal(inv.release(t1), true);
  assert.equal(inv.available('a'), 10);
  assert.equal(inv.release(t1), false); // already released
});

test('reserve unknown sku / insufficient stock returns null', () => {
  const inv = createInventory({ a: 2 });
  assert.equal(inv.reserve('nope', 1), null);
  assert.equal(inv.reserve('a', 3), null);
  assert.equal(inv.available('a'), 2);
});

test('reserve validates quantity', () => {
  const inv = createInventory({ a: 1 });
  assert.throws(() => inv.reserve('a', 0), RangeError);
  assert.throws(() => inv.reserve('a', -1), RangeError);
  assert.throws(() => inv.reserve('a', 1.5), RangeError);
  assert.throws(() => inv.reserve('a', 'x'), RangeError);
});

test('release rejects unknown and foreign tokens', () => {
  const a = createInventory({ x: 1 });
  const b = createInventory({ x: 1 });
  const tokenA = a.reserve('x', 1);
  assert.equal(b.release(tokenA), false); // foreign
  assert.equal(b.release(Symbol('random')), false); // unknown
  assert.equal(b.available('x'), 1); // untouched
  assert.equal(a.release(tokenA), true);
});

test('tokens are unique', () => {
  const inv = createInventory({ a: 100 });
  const t1 = inv.reserve('a', 1);
  const t2 = inv.reserve('a', 1);
  assert.notEqual(t1, t2);
});

test('instances are independent', () => {
  const shared = { a: 5 };
  const p = createInventory(shared);
  const q = createInventory(shared);
  const t = p.reserve('a', 5);
  assert.equal(p.available('a'), 0);
  assert.equal(q.available('a'), 5);
  assert.equal(q.reserve('a', 6), null);
  p.release(t);
  assert.equal(p.available('a'), 5);
  assert.equal(q.available('a'), 5);
});

test('token is opaque object', () => {
  const inv = createInventory({ a: 1 });
  const t = inv.reserve('a', 1);
  assert.equal(typeof t, 'object');
});
