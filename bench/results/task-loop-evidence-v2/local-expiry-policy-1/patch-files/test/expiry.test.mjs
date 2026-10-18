import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protocolVersion, expiresAt} from '../src/expiry.mjs';

test('protocolVersion is preserved', () => {
  assert.equal(protocolVersion, 1);
});

test('expiresAt returns createdAtMs + ttlMs', () => {
  assert.equal(expiresAt(1000, 500), 1500);
  assert.equal(expiresAt(0, 100), 100);
});

test('expiresAt preserves explicit zero ttl', () => {
  assert.equal(expiresAt(5000, 0), 5000);
});

test('expiresAt uses default TTL of 45000 when ttlMs is undefined', () => {
  assert.equal(expiresAt(1000), 46000);
  assert.equal(expiresAt(1000, undefined), 46000);
});

test('expiresAt rejects invalid createdAtMs', () => {
  assert.throws(() => expiresAt(NaN), RangeError);
  assert.throws(() => expiresAt(Infinity), RangeError);
  assert.throws(() => expiresAt(-Infinity), RangeError);
  assert.throws(() => expiresAt(null), RangeError);
  assert.throws(() => expiresAt('1000'), RangeError);
});

test('expiresAt rejects invalid ttlMs', () => {
  assert.throws(() => expiresAt(0, null), RangeError);
  assert.throws(() => expiresAt(0, NaN), RangeError);
  assert.throws(() => expiresAt(0, Infinity), RangeError);
  assert.throws(() => expiresAt(0, -1), RangeError);
  assert.throws(() => expiresAt(0, -0.5), RangeError);
  assert.throws(() => expiresAt(0, '100'), RangeError);
});

test('expiresAt throws when the result is nonfinite', () => {
  assert.throws(() => expiresAt(Number.MAX_VALUE, Number.MAX_VALUE), RangeError);
});
