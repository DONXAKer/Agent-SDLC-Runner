import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyUsage } from '@sdlc-runner/shared';
import { GuidedAskExecutor } from '../src/exec/GuidedAskExecutor.ts';
import { initializePreparation, preparation } from '../src/artifacts/preparation.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ExecRequest, ExecHooks } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

async function resolve(t: TestContext, task: string, question: string, replies: unknown[], files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guided-question-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case');
  mkdirSync(paths.dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  initializePreparation(paths, task, 3);
  writeArtifact(paths.intent, `# Task\n## Открытые вопросы\n- [ ] [блокирующий] ${question}\n`);
  const inputs: Record<string, unknown>[] = [];
  let humanCalls = 0;
  const provider: ChatProvider = { name: 'script', async chat(req) {
    inputs.push(JSON.parse(req.messages[1]!.content));
    assert.ok(inputs.length <= replies.length, 'unexpected extra model request');
    const reply = { ...replies[inputs.length - 1] as Record<string, unknown> };
    if (reply.kind === 'source' || reply.kind === 'engineering') {
      const source = String(reply.source);
      const lineNumber = (reply.lines as number[])[0]!;
      const numbered = String((inputs.at(-1) as any).sources[source]);
      reply.evidenceId = numbered.split('\n').find(line => line.includes(` | ${lineNumber} | `))!.split(' | ')[0]!;
      delete reply.source; delete reply.lines;
    }
    return { text: JSON.stringify(reply), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const req = { cwd: root, model: 'script', guidedEngineVersion: 4, maxTurns: 8, signal: new AbortController().signal,
    prompt: { system: '', user: '' } } as ExecRequest;
  const hooks = { onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
    onAskHuman: async () => { humanCalls++; return {}; } } as unknown as ExecHooks;
  const result = await new GuidedAskExecutor(host, { provider, params: null, contextWindow: 16384 }).run(req, hooks);
  return { result, humanCalls, inputs, state: preparation(paths), report: readFileSync(paths.clarificationReport, 'utf8') };
}

test('future source is identified as unavailable and an internal decision is retained for plan approval', async t => {
  const outcome = await resolve(t, 'Create lib/format.ts to format the record without changing its public contract.',
    'Which internal function name should lib/format.ts use?', [
      { kind: 'context', path: 'lib/format.ts', reason: 'Need the future declaration' },
      { kind: 'engineering', source: 'request-1', lines: [1, 1], category: 'implementation_detail', choice: 'formatRecord', reason: 'Internal helper implementing the requested formatting; plan approval remains required' },
    ]);
  assert.equal(outcome.result.ok, true, outcome.result.note);
  assert.equal(outcome.humanCalls, 0);
  assert.deepEqual(outcome.inputs[0]?.fileFacts, [{ path: 'lib/format.ts', status: 'unavailable' }]);
  assert.match(String(outcome.inputs[1]?.feedback), /lib\/format.ts/);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'engineering');
  assert.ok(outcome.report.includes('formatRecord'));
});

test('exhausted source retrieval is a technical stop and never a yes/no human question', async t => {
  const outcome = await resolve(t, 'Preserve the current parser behavior.', 'How does the existing parser handle empty input?',
    Array(4).fill({ kind: 'context', path: 'parser.ts', reason: 'Need current implementation' }),
    { 'parser.ts': 'export const parse = (s: string) => s.trim();' });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.humanCalls, 0);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'context');
  assert.equal(outcome.inputs.length, 4, 'retrieval remains bounded while every repeated request receives source again');
  for (const input of outcome.inputs.slice(1)) assert.match(JSON.stringify(input.sources), /s.trim/);
  assert.match(outcome.result.note ?? '', /Техническая остановка/);
  assert.match(outcome.report, /пределах бюджета/);
});

test('explicit request priority resolves from its source without a human answer', async t => {
  const outcome = await resolve(t, 'Priority: explicit option, then account configuration, then built-in default.',
    'What priority applies to the option?', [{ kind: 'source', source: 'request-1', lines: [1, 1], answer: 'Explicit option has priority.' }]);
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.humanCalls, 0);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'source');
});

test('a missing business rule remains blocked when the human gives no answer', async t => {
  const outcome = await resolve(t, 'The payment rate is unknown and must be provided by the operator.',
    'Which payment rate applies?', [{ kind: 'human', missingDecision: 'Payment rate', options: ['Standard', 'Reduced'], consequence: 'Different charge', reason: 'The source explicitly leaves the rate unknown' }]);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.humanCalls, 1);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'human');
});

test('engineering classification cannot settle an access policy', async t => {
  const reply = { kind: 'engineering', source: 'request-1', lines: [1, 1], category: 'implementation_detail', choice: 'Allow', reason: 'Implementation choice' };
  const outcome = await resolve(t, 'Authorization permission is undecided.', 'Which authorization permission should the implementation use?', Array(4).fill(reply));
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'protocol');
  assert.ok(!outcome.report.includes('| Allow |'));
});

test('an explicitly undecided source policy cannot be laundered as an internal implementation choice', async t => {
  const outcome = await resolve(t, 'The internal retention policy is undecided.',
    'Which internal implementation choice should retain records?', [{ kind: 'engineering', source: 'request-1', lines: [1, 1],
      category: 'implementation_detail', choice: 'Retain everything', reason: 'Internal implementation choice' }]);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.humanCalls, 1);
  assert.equal(outcome.state?.questionJournal?.entries[0]?.status, 'human');
});
