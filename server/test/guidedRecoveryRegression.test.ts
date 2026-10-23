import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyUsage } from '@sdlc-runner/shared';
import { applySymbolOp } from '../src/exec/symbolOps.ts';
import { guidedActionResponseFormat } from '../src/exec/GuidedExecutor.ts';
import { guidedCapabilities } from '../src/exec/guidedCapabilities.ts';
import { rebuildGuidedObject } from '../src/exec/guidedRecovery.ts';
import { guidedFillClaims } from '../src/run/guidedVerificationProtocol.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const turn = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const, usage: emptyUsage() });

test('document edits require unique text, current hash and a document target', () => {
 const before = '# Settings\nDelay: 2\n';
 const op = { op: 'replace_text' as const, file: 'docs/settings.md', expectedHash: hash(before), search: 'Delay: 2', replacement: 'Delay: 4' };
 assert.equal(applySymbolOp(before, op), '# Settings\nDelay: 4\n');
 assert.throws(() => applySymbolOp(before + '\n', op), /изменился/);
 assert.throws(() => applySymbolOp(before, { ...op, search: 'missing' }), /ровно один/);
 assert.throws(() => applySymbolOp('xx', { ...op, search: 'x', expectedHash: hash('xx') }), /ровно один/);
 assert.throws(() => applySymbolOp(before, { ...op, file: 'lib/module.ts' }), /документы/);
 assert.throws(() => applySymbolOp(before, { op: 'ensure_import', file: op.file, from: './mod', names: ['run'] }), /replace_text/);
 const card = { path: op.file, hash: hash(before), symbols: [], isNew: false };
 const caps = guidedCapabilities([card], []);
 assert.deepEqual(caps[0]!.ops, ['replace_text']);
 const format = JSON.stringify(guidedActionResponseFormat([card], false, undefined, caps));
 assert.match(format, /replace_text/); assert.doesNotMatch(format, /replace_body|ensure_import/);
});

test('object reconstruction asks one field at a time and rejects unsolicited keys', async () => {
 const format = { json_schema: { name: 'sample', schema: { properties: { fact: { type: 'string' }, changed: { type: 'boolean' } } } } };
 const fields: string[] = [];
 const result = await rebuildGuidedObject(format, async (_schema, keys) => { fields.push(...keys); return turn({ [keys[0]!]: keys[0] === 'fact' ? 'Observed source' : false }); });
 assert.deepEqual(result, { fact: 'Observed source', changed: false });
 assert.deepEqual(fields, ['fact', 'changed']);
 await assert.rejects(rebuildGuidedObject(format, async () => turn({ fact: 'x', extra: true })), /only field/);
});

for (const repaired of [true, false]) test(`unsupported negative claim is never a code failure (repair=${repaired})`, async () => {
 let count = 0;
 const result = await guidedFillClaims({ provider: { name: 'fixture', async chat() {
  count++; return turn(count === 2 && repaired ? { status: '✅', evidence: 'lib/public.ts:publish; required export added', fix: '' } : { status: '❌', evidence: 'lib/public.ts:publish', fix: '' });
 } }, model: 'fixture', params: null, system: '', claims: [{ id: 'claim-1', text: 'Preserve existing files except the requested public export.' }],
 diff: 'diff --git a/lib/public.ts b/lib/public.ts\n+export { publish } from "./publish.ts";', tests: '', evidenceBudgetBytes: 10000, signal: new AbortController().signal });
 assert.equal(count, 2); assert.equal(result.calls.length, repaired ? 1 : 0);
 if (result.calls[0]?.kind === 'record_claim') assert.equal(result.calls[0].status, '✅');
});

test('substantiated negative claim remains blocking', async () => {
 const result = await guidedFillClaims({ provider: { name: 'fixture', async chat() { return turn({ status: '❌', evidence: 'lib/count.ts:count returns zero', fix: 'Return the requested count.',
  rejection: { requirementQuote: 'Return two.', observed: 'count returns 0', explanation: 'Zero is not the required two; no exceptions apply.', relatedClaimIds: ['claim-1'] } }); } },
 model: 'fixture', params: null, system: '', claims: [{ id: 'claim-1', text: 'Return two.' }], diff: 'diff --git a/lib/count.ts b/lib/count.ts\n+export const count = () => 0;', tests: '', evidenceBudgetBytes: 10000, signal: new AbortController().signal });
 assert.equal(result.calls.length, 1);
 if (result.calls[0]?.kind === 'record_claim') assert.equal(result.calls[0].status, '❌');
});
