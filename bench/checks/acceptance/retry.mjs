import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), 'src/index.ts')).href);
test('G1 [contract]: equal bodies reuse the real id; different keys and absent keys send', () => {
  let sent = 0;
  const transport = { send: () => `issued-${++sent}` };
  const body = Object.freeze({ to: 'audit@example.org', text: 'Notice', phone: '+79001234567' });
  const first = target.sendNotification(transport, body, { idempotencyKey: 'acceptance-main' });
  assert.equal(first.id, 'issued-1');
  assert.equal(target.sendNotification(transport, { ...body }, { idempotencyKey: 'acceptance-main' }).id, first.id);
  assert.equal(sent, 1);
  target.sendNotification(transport, body, { idempotencyKey: 'acceptance-other' });
  target.sendNotification(transport, body);
  target.sendNotification(transport, body, { idempotencyKey: undefined });
  assert.equal(sent, 4);
});
test('G2 [contract]: each differing message field rejects reuse without sending', () => {
  for (const field of ['to', 'text', 'phone']) {
    let sent = 0;
    const transport = { send: () => `issued-${++sent}` };
    const key = `acceptance-conflict-${field}`;
    const body = { to: 'audit@example.org', text: 'Notice', phone: '+79001234567' };
    target.sendNotification(transport, body, { idempotencyKey: key });
    assert.throws(() => target.sendNotification(transport, { ...body, [field]: 'changed' }, { idempotencyKey: key }));
    assert.equal(sent, 1);
  }
});
