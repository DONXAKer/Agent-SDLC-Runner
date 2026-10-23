import test from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, apiRevision } from '../src/index.ts';
test('existing contract', () => { assert.equal(inWindow(3, 1, 5), true); assert.equal(inWindow(6, 1, 5), false); assert.equal(apiRevision, 1); });

