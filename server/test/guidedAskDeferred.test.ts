import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { GuidedAskExecutor } from '../src/exec/GuidedAskExecutor.ts';
import { initializePreparation, preparation, savePreparation } from '../src/artifacts/preparation.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initGuided } from '../src/run/guidedState.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import { questionDigest } from '../src/exec/guidedQuestions.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ask-deferred-'));
  const paths = new WitokPaths(root, 'test');
  initGuided(paths, 'local:test');
  initializePreparation(paths, 'Request.', 3);
  return { root, paths };
}

const request = (root: string): ExecRequest => ({
  cwd: root, model: 'test', allowedTools: ['Read', 'Grep', 'Write', 'Edit'],
  signal: new AbortController().signal, maxTurns: 20, maxBudgetUsd: null,
  prompt: { system: '', user: '' } as ExecRequest['prompt'], readOnlyDirs: [], subagents: [], mcp: null,
  finishGuard: null, salvageFromText: null,
});

const hooks = (): ExecHooks => ({
  onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {},
  onAskHuman: async () => ({}), onRecord: () => '',
});

function failingProvider(): ChatProvider {
  return {
    name: 'test', chat: async () => {
      throw new Error('模型拒绝生成合法 JSON');
    },
  } as unknown as ChatProvider;
}

function host(paths: WitokPaths): StageHost {
  return {
    paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text),
  } as unknown as StageHost;
}

function seedQuestion(paths: WitokPaths, origin: string[], status: 'protocol' | 'human' = 'protocol') {
  const state = preparation(paths)!;
  state.questionJournal = {
    version: 1,
    entries: [{
      id: 'q1', question: 'Какое правило для edge case?', origin,
      requestHash: questionDigest(JSON.stringify(state.requests)),
      status, answer: '', reason: 'кандидат', options: [], sourceHashes: {}, citations: [],
    }],
  };
  savePreparation(paths, state);
}

test('auto origin question is deferred after four protocol failures', async () => {
  const { root, paths } = fixture();
  seedQuestion(paths, ['intent']);
  const result = await new GuidedAskExecutor(host(paths), { provider: failingProvider(), params: null, contextWindow: 16384 })
    .run(request(root), hooks());
  assert.equal(result.ok, true, result.note);
  const entry = preparation(paths)?.questionJournal?.entries[0];
  assert.equal(entry?.status, 'deferred');
  assert.equal(entry?.answer, 'не удалось автоматически обосновать; передано в план');
  const report = readFileSync(paths.clarificationReport, 'utf8');
  assert.ok(report.includes('deferred'));
});

test('human-origin question stays protocol after failures and blocks the stage', async () => {
  const { root, paths } = fixture();
  seedQuestion(paths, ['human']);
  const result = await new GuidedAskExecutor(host(paths), { provider: failingProvider(), params: null, contextWindow: 16384 })
    .run(request(root), hooks());
  assert.equal(result.ok, false);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'protocol');
});

test('legacy-origin question stays protocol after failures and blocks the stage', async () => {
  const { root, paths } = fixture();
  seedQuestion(paths, ['legacy-report']);
  const result = await new GuidedAskExecutor(host(paths), { provider: failingProvider(), params: null, contextWindow: 16384 })
    .run(request(root), hooks());
  assert.equal(result.ok, false);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'protocol');
});
