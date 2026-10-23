import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMessage, encodeMessage, decodeMessage, apiRevision } from '../src/index.ts';
test('existing contract', () => { assert.equal(typeof encodeMessage(makeMessage('ok')), 'string'); assert.throws(() => makeMessage(null), TypeError); assert.equal(apiRevision, 1); });

