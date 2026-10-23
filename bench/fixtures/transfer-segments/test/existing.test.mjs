import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, apiRevision } from '../src/index.ts';
test('existing contract', () => { assert.equal(normalizeKey('Alpha'), 'Alpha'); assert.throws(() => normalizeKey(null), TypeError); assert.equal(apiRevision, 1); });

