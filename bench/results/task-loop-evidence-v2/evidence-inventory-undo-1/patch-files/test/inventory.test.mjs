import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInventory, protocolVersion} from '../src/inventory.mjs';

test('createInventory keeps existing export and copies initial', () => {
  assert.equal(protocolVersion, 1);
  const a = {x: 3};
  const inv = createInventory(a);
  a.x = 99;
  assert.equal(inv.available('x'), 3);
  assert.equal(inv.available('missing'), 0);
});

test('reserve validates quantity', () => {
  const inv = createInventory({a: 10});
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', null, undefined]) {
    assert.throws(() => inv.reserve('a', bad), RangeError);
  }
});

test('reserve returns null for unknown SKU or insufficient stock', () => {
  const inv = createInventory({a: 3});
  assert.equal(inv.reserve('nope', 1), null);
  assert.equal(inv.reserve('a', 4), null);
  assert.equal(inv.available('a'), 3);
});

test('reserve subtracts, release restores once, tokens are opaque/unique', () => {
  const inv = createInventory({a: 10});
  const t1 = inv.reserve('a', 4);
  const t2 = inv.reserve('a', 6);
  assert.ok(typeof t1 === 'string' && t1.length > 0);
  assert.notEqual(t1, t2);
  assert.equal(inv.available('a'), 0);

  assert.equal(inv.release(t1), true);
  assert.equal(inv.available('a'), 4);
  assert.equal(inv.release(t1), false);
  assert.equal(inv.available('a'), 4);

  assert.equal(inv.release(t2), true);
  assert.equal(inv.available('a'), 10);
});

test('release rejects unknown and foreign tokens', () => {
  const a = createInventory({x: 1});
  const b = createInventory({x: 1});
  const ta = a.reserve('x', 1);
  assert.equal(b.release(ta), false);
  assert.equal(a.release('bogus'), false);
  assert.equal(a.available('x'), 0);
  assert.equal(b.available('x'), 1);
  assert.equal(a.release(ta), true);
  assert.equal(a.available('x'), 1);
});

test('instances are independent', () => {
  const a = createInventory({k: 5});
  const b = createInventory({k: 5});
  a.reserve('k', 5);
  assert.equal(a.available('k'), 0);
  assert.equal(b.available('k'), 5);
});
