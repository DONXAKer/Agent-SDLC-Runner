import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { guidedProposal } from '../src/exec/guidedProposal.ts';

test('secondary proposals preserve accepted neighbours and narrowed repair across interruption', async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-proposal-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  const paths = new WitokPaths(root, 'test');
  const schema = z.object({ good: z.string(), bad: z.number() }).strict();
  const format = { type: 'json_schema', json_schema: { name: 'test', schema: z.toJSONSchema(schema) } };
  const options = () => ({ store: new GuidedProgress(paths), id: 'intent:repair', stage: 'intent' as const,
    signal: new AbortController().signal, dependencies: () => ({ source: 'v1' }), format,
    validate: (text: string) => schema.parse(JSON.parse(text)) });
  let calls = 0;
  await assert.rejects(() => guidedProposal({ ...options(), ask: async () => {
    if (++calls === 4) throw new Error('provider disconnected');
    return { text: JSON.stringify({ good: 'preserve me', bad: 'invalid' }), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } }), /disconnected/);
  assert.equal(new GuidedProgress(paths).read().recoveries['intent:repair']?.failures, 3);
  const result = await guidedProposal({ ...options(), ask: async (_feedback, narrowed, fields) => {
    assert.deepEqual(fields, ['bad']);
    assert.deepEqual((narrowed.json_schema as { schema: { required: string[] } }).schema.required, ['bad']);
    return { text: '{"bad":2}', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } });
  assert.deepEqual(JSON.parse(result), { good: 'preserve me', bad: 2 });
  assert.equal(await guidedProposal({ ...options(), ask: async () => { throw new Error('must reuse'); } }), result);
});

test('secondary proposal rejects a changed source after the model answered', async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-proposal-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  let source = 'before';
  await assert.rejects(() => guidedProposal({ store: new GuidedProgress(new WitokPaths(root, 'test')),
    id: 'intent:repair', stage: 'intent', signal: new AbortController().signal, dependencies: () => ({ source }),
    format: {}, validate: JSON.parse, ask: async () => {
      source = 'after'; return { text: '{}', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
    } }), /устарело/);
});
