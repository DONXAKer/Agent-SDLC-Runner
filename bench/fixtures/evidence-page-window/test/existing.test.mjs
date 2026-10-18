import {test} from 'node:test'; import assert from 'node:assert/strict'; import {protocolVersion} from '../src/page.mjs'; test('existing public API',()=>assert.equal(protocolVersion,1));
