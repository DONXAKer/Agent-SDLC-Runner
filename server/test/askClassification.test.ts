import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyUsage } from '@sdlc-runner/shared';
import { classifyGuidedQuestion, GuidedAskExecutor } from '../src/exec/GuidedAskExecutor.ts';
import { initializePreparation, preparation, savePreparation } from '../src/artifacts/preparation.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

test('question classes separate settled, optional and genuinely blocking entries', () => {
  assert.equal(classifyGuidedQuestion({ status: 'source' }), 'already-answered');
  assert.equal(classifyGuidedQuestion({ status: 'engineering' }), 'already-answered');
  assert.equal(classifyGuidedQuestion({ status: 'answered' }), 'already-answered');
  assert.equal(classifyGuidedQuestion({ status: 'deferred' }), 'deferrable');
  for (const status of ['human', 'context', 'protocol'] as const) assert.equal(classifyGuidedQuestion({ status }), 'blocking');
});

test('an explicitly optional question needs neither a model answer nor a human answer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ask-classification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case');
  initializePreparation(paths, 'Implement the requested behavior.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [неблокирующий] Which naming policy is required?\n');
  let modelCalls = 0;
  let humanCalls = 0;
  const provider: ChatProvider = { name: 'script', async chat() {
    modelCalls++;
    return { text: JSON.stringify({ kind: 'human', missingDecision: 'Required naming policy', options: ['First', 'Second'], consequence: 'Different public behavior', reason: 'Not specified' }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const req = { cwd: root, model: 'script', guidedEngineVersion: 5, maxTurns: 4, signal: new AbortController().signal,
    prompt: { system: '', user: '' } } as ExecRequest;
  const hooks = { onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
    onAskHuman: async () => { humanCalls++; return {}; } } as unknown as ExecHooks;
  const result = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  assert.equal(result.ok, true, result.note);
  assert.equal(modelCalls, 0);
  assert.equal(humanCalls, 0);
  const entry = preparation(paths)?.questionJournal?.entries[0];
  assert.equal(entry?.status, 'deferred');
  assert.equal(entry?.answer, '');
  assert.match(readFileSync(paths.clarificationReport, 'utf8'), /deferrable/);
  assert.match(readFileSync(paths.intent, 'utf8'), /- \[ \] \[неблокирующий\]/);

  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Which naming policy is required?\n');
  const reclassified = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  assert.equal(reclassified.ok, false);
  assert.equal(modelCalls, 1);
  assert.equal(humanCalls, 1);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'human');
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.answer, '');

  writeArtifact(paths.explorationReport, '# Explore\n## Вопросы человеку\n- [ ] [неблокирующий] Which naming policy is required?\n');
  const conflictingOrigins = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  assert.equal(conflictingOrigins.ok, false, 'a blocking Intent record dominates an optional Explore record');
  assert.equal(modelCalls, 2);
  assert.equal(humanCalls, 2);

  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [неблокирующий] Which naming policy is required?\n');
  const stale = preparation(paths)!;
  stale.questionJournal!.entries[0]!.status = 'source';
  stale.questionJournal!.entries[0]!.answer = 'Outdated answer';
  stale.questionJournal!.entries[0]!.sourceHashes = { 'request-1': 'stale' };
  savePreparation(paths, stale);
  const optionalStale = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  assert.equal(optionalStale.ok, true, optionalStale.note);
  assert.equal(modelCalls, 2);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'deferred');
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.answer, '');
});

test('citation rejection is not accepted and the next attempt receives numbered sources and feedback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ask-citation-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case');
  initializePreparation(paths, 'The timeout is 30 seconds.\nAn unrelated implementation note.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] What timeout is required?\n');
  const packets: any[] = [];
  const params: Array<Record<string, unknown> | null | undefined> = [];
  const validations: Array<{ accepted: boolean; reason: string }> = [];
  const provider: ChatProvider = { name: 'ollama', async chat(request) {
    packets.push(JSON.parse(request.messages[1]!.content));
    params.push(request.params);
    const lineNumber = packets.length === 1 ? 2 : 1;
    const numbered = packets.at(-1).sources['request-1'] as string;
    const evidenceId = numbered.split('\n').find(line => line.includes(` | ${lineNumber} | `))!.split(' | ')[0]!;
    return { text: JSON.stringify({ kind: 'source', evidenceId, answer: 'Use the required timeout' }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const req = { cwd: root, model: 'ollama:test', guidedEngineVersion: 5, maxTurns: 4, signal: new AbortController().signal,
    prompt: { system: '', user: '' } } as ExecRequest;
  const hooks = { onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
    onQuestionValidated: (event: { accepted: boolean; reason: string }) => validations.push(event),
    onAskHuman: async () => ({}) } as unknown as ExecHooks;
  const result = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  assert.equal(result.ok, true, result.note);
  assert.equal(packets.length, 2);
  assert.match(packets[0].sources['request-1'], /^evidence-[a-f0-9]{24} \| 1 \| The timeout/);
  assert.match(packets[1].feedback, /Цитата не адресует/);
  assert.equal(params[0]?.['max_tokens'], 4096);
  assert.equal(params[0]?.['reasoning_effort'], 'none');
  assert.deepEqual(validations.map(event => event.accepted), [false, true]);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.citations[0]?.quote, 'The timeout is 30 seconds.\nAn unrelated implementation note.');
});
