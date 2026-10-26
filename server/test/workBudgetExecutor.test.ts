import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { FormFillExecutor } from '../src/exec/FormFillExecutor.ts';
import { GuidedExecutor } from '../src/exec/GuidedExecutor.ts';
import { WorkBudgetExhausted } from '../src/exec/workBudget.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { initGuided } from '../src/run/guidedState.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

const hooks = (): ExecHooks => ({ onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {},
  onAskHuman: async () => ({}), onRecord: () => '' });

function request(root: string, artifact?: string): ExecRequest {
  return { cwd: root, model: 'test', allowedTools: ['Read', 'Write', 'Edit'], signal: new AbortController().signal,
    maxTurns: 20, maxBudgetUsd: null, prompt: { presetNote: null, system: '', user: 'task', tools: [], editedByOperator: false },
    readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null,
    ...(artifact === undefined ? {} : { formArtifacts: [artifact] }) } as ExecRequest;
}

test('chunk rolls back and rethrows work-budget exhaustion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'work-budget-chunk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'test');
  initGuided(paths, 'local:test', 5);
  writeFileSync(join(root, 'a.ts'), 'export const n = 1;\n');
  const exhausted = new WorkBudgetExhausted('requests', 'work', 'cap');
  const provider: ChatProvider = { name: 'budget', async chat() { throw exhausted; } };
  const executor = new GuidedExecutor({ paths, provider,
    items: [{ id: 'work-1', title: 'change', files: ['a.ts'], claims: ['claim-1'], dependsOn: [], prediction: 'checked', checks: ['check'], status: 'pending', attempts: 0, repartitioned: false }],
    inputRevision: () => 'r1', requirements: '{}', sources: '', contextWindow: 16000,
    check: async () => ({ passed: true, result: 'ok' }) });
  await assert.rejects(executor.run({ ...request(root), guidedEngineVersion: 5, progress: new GuidedProgress(paths) }, hooks()),
    error => error === exhausted);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const n = 1;\n');
});

for (const compact of [false, true]) test(`form fill persists paid sibling answers before budget exhaustion (compact=${compact})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'work-budget-form-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = join(root, 'intent.md');
  writeFileSync(artifact, '- **Цель:** ‹цель›\n- **Причина:** ‹причина›\n');
  const exhausted = new WorkBudgetExhausted('requests', 'work', 'cap');
  let calls = 0;
  const provider: ChatProvider = { name: 'budget', async chat() {
    calls++;
    if (calls > 1) throw exhausted;
    return { text: 'Сделать демо', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const run = new FormFillExecutor({ provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000, compact })
    .run(request(root, artifact), hooks());
  await assert.rejects(run, error => error === exhausted);
  const saved = readFileSync(artifact, 'utf8');
  assert.match(saved, /Сделать демо/);
  assert.match(saved, /‹/);
});
