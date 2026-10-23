import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '@sdlc-runner/shared';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import { guidedFillClaims } from '../src/run/guidedVerificationProtocol.ts';

for (const manualAllowed of [false, true]) {
  test(`claim manual classification requires explicit contract permission (${manualAllowed})`, async () => {
    let calls = 0;
    const provider: ChatProvider = { name: 'claim-contract', async chat(request) {
      calls++;
      if (!manualAllowed && calls === 2) assert.match(JSON.stringify(request.messages), /manual/);
      return { text: JSON.stringify({ status: calls === 1 ? 'manual' : '⚠', evidence: 'lib/check.ts:inspect', fix: 'Missing executable evidence' }),
        toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
    } };
    const result = await guidedFillClaims({ provider, model: 'fixture', params: null, system: '',
      claims: [{ id: 'claim-1', text: 'inspect returns a nonempty value', manualAllowed }],
      diff: 'diff --git a/lib/check.ts b/lib/check.ts\n+export function inspect() { return 1; }',
      tests: '', evidenceBudgetBytes: 10000, signal: new AbortController().signal });
    assert.equal(calls, manualAllowed ? 1 : 2);
    assert.equal(result.calls.length, 1);
    const record = result.calls[0]!;
    assert.equal(record.kind, 'record_claim');
    if (record.kind === 'record_claim') assert.equal(record.status, manualAllowed ? 'manual' : '⚠');
  });
}
