import '../acceptance/retry.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFunction } from './module-contract.mjs';
const target = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), 'src/index.ts')).href);
test('G3 [contract]: required source module exports the function', () => assertFunction('src/sender.ts', 'sendNotification'));
test('G4 [contract]: key is bound to the original values despite caller mutation', () => {
  let sent = 0;
  const transport = { send: () => `snapshot-${++sent}` };
  const body = { to: 'audit@example.org', text: 'original', phone: '+79001234567' };
  const opts = { idempotencyKey: 'acceptance-v2-snapshot' };
  target.sendNotification(transport, body, opts);
  body.text = 'changed';
  assert.throws(() => target.sendNotification(transport, { ...body }, opts));
  assert.equal(sent, 1);
});
