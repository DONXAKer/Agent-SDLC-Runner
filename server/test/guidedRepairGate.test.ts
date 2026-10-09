import { strictEqual, ok } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { PolicyContext } from '@sdlc-runner/shared';
import { FormFillExecutor } from '../src/exec/FormFillExecutor.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { ExecRequest, ExecHooks } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

const originalRows = Array.from({ length: 5 }, (_, i) => ({ id: `claim-${i + 1}`, behavior: `Value ${i + 1}`, procedure: `Check ${i + 1}`, expected: `Result ${i + 1}` }));
async function runRepair(values: unknown[], mutation?: (path: string) => void, afterApproval?: (path: string, abort: AbortController) => void,
  basis = false) {
  const root = mkdtempSync(join(tmpdir(), 'repair-gate-'));
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const artifact = join(root, '.sdlc', 'demo', 'intent.md');
  const originalBasis = originalRows.map(row => ({ id: row.id, basis: { file: 'request-1', lines: [1, 1] }, scenario: row.behavior, counterexample: 'Else' }));
  const section = basis ? 'Основания и сценарии' : 'Приёмочный лист';
  const before = '# Task\n\n## Что делаем\nKeep this section byte for byte.\n\n## Приёмочный лист\n<!-- sdlc-json:acceptance:start -->\n' + JSON.stringify(originalRows, null, 2) + '\n<!-- sdlc-json:acceptance:end -->\n\n' + (basis ? '## Основания и сценарии\n<!-- sdlc-json:basis:start -->\n' + JSON.stringify(originalBasis, null, 2) + '\n<!-- sdlc-json:basis:end -->\n\n' : '') + '## Инварианты\nKeep this too.\n';
  writeFileSync(artifact, before);
  const denied: string[] = [];
  const gate = new ApprovalGate({ onPending: p => {
    if (p.destructive) { denied.push(p.destructive); queueMicrotask(() => gate.resolve('repair', p.requestId, { allowed: false, reason: p.destructive!, by: 'operator' })); }
  }, onResolved: (_, d) => { if (!d.allowed) denied.push(d.reason); } });
  gate.setAutoApprove('repair', 'intent', { rest: true, planWrites: false, bash: false, mcpWrites: false });
  const ctx: PolicyContext = { projectRoot: root, stage: 'intent', sdlcDir: '.sdlc/demo', planFiles: null,
    protectedArtifacts: [], readOnlyRoots: [], allowedTools: ['Write', 'Read', 'Edit'], mcpTools: [], stageArtifacts: [{ key: 'intent', path: artifact }] };
  let reviews = 0;
  const abort = new AbortController();
  const provider: ChatProvider = { name: 'external-model-fixture', async chat(req) {
    const input = JSON.parse(req.messages[1]!.content);
    const repair = input.questionId.startsWith('intent:repair:');
    if (repair) mutation?.(artifact);
    return { text: JSON.stringify(repair ? { section, values } : { issues: reviews++ === 0 ? [{ problem: 'Fix first expected result',
      quotes: [{ section, lines: [1, 1] }], source: { file: 'request-1', lines: [1, 1] } }] : [] }),
      toolCalls: [], finishReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1 } };
  } };
  const validations: { accepted: boolean; reason: string }[] = [];
  const hooks = { onText() {}, onThinking() {}, onWarn() {}, onUsage() {}, onFriction() {}, onToolResult() {},
    onQuestionValidated: (v: { accepted: boolean; reason: string }) => validations.push(v),
    onToolRequest: async (call, meta) => {
      const decision = await gate.request({ ...meta, call, ctx, runId: 'repair', stage: 'intent' });
      if (decision.allowed) afterApproval?.(artifact, abort);
      return decision;
    },
    onAskHuman: async () => ({}), onRecord: () => '' } as ExecHooks;
  const request = { cwd: root, model: 'fixture', allowedTools: ctx.allowedTools, mcp: null, readOnlyDirs: [], subagents: [],
    formArtifacts: [artifact], maxTurns: 10, maxBudgetUsd: null, signal: abort.signal,
    prompt: { system: '', user: '{"data":{"requests":["Correct result"]}}', tools: [], presetNote: null, editedByOperator: false, guidedProtocol: true },
    finishGuard: () => null, salvageFromText: null } as ExecRequest;
  const result = await new FormFillExecutor({ provider, stage: 'intent', compact: true, reviewIntentContract: true,
    intentRequests: ['Correct result'], maxResultBytes: 10000, readRangeRequiredAboveBytes: 10000, bashTimeoutMs: 1000 }).run(request, hooks);
  const after = readFileSync(artifact, 'utf8'); rmSync(root, { recursive: true, force: true });
  return { result, before, after, denied, validations };
}

it('repair writes corrected JSON facts through the real gate without table compression or touching other sections', async () => {
  const outcome = await runRepair(originalRows.map(row => row.id === 'claim-1' ? { ...row, expected: 'Correct result' } : row));
  strictEqual(outcome.result.ok, true, outcome.result.note);
  strictEqual(outcome.after, outcome.before.replace('Result 1', 'Correct result'));
  strictEqual(outcome.denied.length, 0);
  ok(outcome.validations.some(v => v.accepted));
});

it('repair never overwrites an operator change made while the real gate resolves', async () => {
  const outcome = await runRepair(originalRows.map(row => ({ ...row, expected: 'Correct result' })), undefined,
    path => writeFileSync(path, readFileSync(path, 'utf8') + '\nOperator change\n'));
  strictEqual(outcome.result.ok, false);
  strictEqual(outcome.after, outcome.before + '\nOperator change\n');
  ok(outcome.validations.some(v => v.accepted && v.reason.includes('JSON')));
  ok(outcome.validations.some(v => !v.accepted && v.reason.includes('запис')));
});

it('repair cancelled during approval leaves the checked document intact', async () => {
  const outcome = await runRepair(originalRows.map(row => ({ ...row, expected: 'Correct result' })), undefined,
    (_, abort) => abort.abort(new Error('Operator cancelled')));
  strictEqual(outcome.result.ok, false);
  strictEqual(outcome.after, outcome.before);
});

it('repair refuses deletion or substitution of requirement IDs before writing', async () => {
  for (const values of [originalRows.slice(1), originalRows.map(row => ({ ...row, id: 'claim-99' }))]) {
    const outcome = await runRepair(values);
    strictEqual(outcome.result.ok, false);
    strictEqual(outcome.after, outcome.before);
    ok(outcome.result.note?.includes('ID'));
  }
});

it('repair refuses removal of procedure or expected criterion even when every ID remains', async () => {
  for (const field of ['procedure', 'expected']) {
    for (const value of ['', undefined]) {
      const outcome = await runRepair(originalRows.map(row => ({ ...row, [field]: value })));
      strictEqual(outcome.result.ok, false);
      strictEqual(outcome.after, outcome.before);
    }
  }
});

it('basis repair validates citations before retaining canonical JSON serialization', async () => {
  const values = originalRows.map(row => ({ id: row.id, basis: { file: 'request-1', lines: [1, 2] }, scenario: row.behavior, counterexample: 'Else' }));
  const outcome = await runRepair(values, undefined, undefined, true);
  strictEqual(outcome.result.ok, false);
  strictEqual(outcome.after, outcome.before);
  ok(outcome.result.note?.includes('вне источника'));
});

it('basis correction preserves every source reference and unrelated acceptance through the real gate', async () => {
  const values = originalRows.map(row => ({ id: row.id, basis: { file: 'request-1', lines: [1, 1] },
    scenario: row.id === 'claim-1' ? 'Correct scenario' : row.behavior, counterexample: 'Else' }));
  const outcome = await runRepair(values, undefined, undefined, true);
  strictEqual(outcome.result.ok, true, outcome.result.note);
  const basisStart = outcome.before.indexOf('## Основания и сценарии');
  strictEqual(outcome.after, outcome.before.slice(0, basisStart) + outcome.before.slice(basisStart).replace('Value 1', 'Correct scenario'));
  strictEqual(outcome.denied.length, 0);
});
