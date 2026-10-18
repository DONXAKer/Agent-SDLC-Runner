import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { GuidedExploreExecutor } from '../src/exec/GuidedExploreExecutor.ts';
import type { ExploreExecutorOptions } from '../src/exec/ExploreExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

test('research resumes after cancellation without regenerating completed files, then invalidates changed source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-resume-'));
  t.after(() => { assert.ok(!relative(tmpdir(), root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  const paths = new WitokPaths(root, 'task');
  for (const file of ['a.ts', 'b.ts']) writeFileSync(join(root, file), 'export const value = 1;');
  const hooks: ExecHooks = { onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
    onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {}, onAskHuman: async () => ({}), onRecord: () => '' };
  let calls = 0; let interrupt = true;
  const provider = { name: 'test', chat: async () => {
    calls++;
    if (interrupt && calls === 2) throw new Error('cancelled between files');
    return { text: JSON.stringify({ fact: 'value is one', impact: 'retain value', change: null, reuse: null, risks: [], questions: [] }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } } as ChatProvider;
  const options = () => ({ provider, built: { ranked: ['a.ts', 'b.ts'].map(path => ({ file: { path, text: readFileSync(join(root, path), 'utf8') } })) },
    intent: { path: paths.intent, title: 'case', claims: [] }, reportPath: paths.explorationReport,
    maxResultBytes: 10000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000 } as unknown as ExploreExecutorOptions);
  const req = (): ExecRequest => ({ cwd: root, model: 'test', allowedTools: ['Write', 'Read'], signal: new AbortController().signal,
    maxTurns: 10, maxBudgetUsd: null, prompt: { system: '', user: '' } as ExecRequest['prompt'], readOnlyDirs: [], subagents: [], mcp: null,
    finishGuard: null, salvageFromText: null, progress: new GuidedProgress(paths) });
  await assert.rejects(() => new GuidedExploreExecutor(options()).run(req(), hooks), /cancelled/);
  assert.equal(new GuidedProgress(paths).read().units['explore:a.ts']?.status, 'proposed');
  interrupt = false;
  const resumed = await new GuidedExploreExecutor(options()).run(req(), hooks);
  assert.equal(resumed.ok, true); assert.equal(resumed.modelRequests, 1); assert.equal(calls, 3);
  writeFileSync(join(root, 'b.ts'), 'export const value = 2;');
  const updated = await new GuidedExploreExecutor(options()).run(req(), hooks);
  assert.equal(updated.ok, true); assert.equal(updated.modelRequests, 1); assert.equal(calls, 4);
  const priorReport = readFileSync(paths.explorationReport, 'utf8');
  const changedDuringApproval = await new GuidedExploreExecutor(options()).run(req(), { ...hooks,
    onToolRequest: async () => {
      writeFileSync(join(root, 'a.ts'), 'export const value = 3;');
      return { allowed: true, updatedInput: null, by: 'policy' };
    } });
  assert.equal(changedDuringApproval.ok, false);
  assert.match(changedDuringApproval.note, /Исходники изменились/);
  assert.equal(readFileSync(paths.explorationReport, 'utf8'), priorReport);
});
