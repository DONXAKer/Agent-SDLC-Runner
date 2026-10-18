import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protocolVersion, expiresAt} from '../src/expiry.mjs';

test('protocolVersion stays 1', () => {
  assert.equal(protocolVersion, 1);
});

test('explicit nonnegative ttl returns createdAtMs+ttlMs', () => {
  assert.equal(expiresAt(1000, 2000), 3000);
});

test('explicit zero ttl preserves zero', () => {
  assert.equal(expiresAt(1000, 0), 1000);
});

test('undefined ttl uses default 45000', () => {
  assert.equal(expiresAt(1000), 46000);
});

test('rejects non-finite createdAtMs', () => {
  for (const value of [NaN, Infinity, -Infinity, null, undefined, '1000', true, {}]) {
    assert.throws(() => expiresAt(value, 10), RangeError);
  }
});

test('rejects invalid ttlMs', () => {
  for (const value of [NaN, Infinity, -Infinity, null, '1000', true, {}, [], -1]) {
    assert.throws(() => expiresAt(1000, value), RangeError);
  }
});

test('finite inputs always yield finite results', () => {
  const result = expiresAt(Number.MAX_SAFE_INTEGER / 2, Number.MAX_SAFE_INTEGER / 2);
  assert.ok(Number.isFinite(result));
  assert.equal(result, Number.MAX_SAFE_INTEGER);
});
