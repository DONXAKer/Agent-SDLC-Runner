import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage, STAGE_ORDER, type StageDecisionCheck } from '@sdlc-runner/shared';
import { checkStageDecision, stageDecisionInstructions } from '../src/exec/StageDecisionCheck.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { ProviderEnvError } from '../src/provider/ChatProvider.ts';
import { questionKey } from '../src/exec/guidedQuestions.ts';
import { closeGuidedQuestions } from '../src/exec/GuidedAskExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

const ready = (decision = 'Проверить существующий механизм') => ({ decision, evidence: [{ source: 'stage-input', quote: 'Проверить лимит' }], uncertainties: [], next: { action: 'proceed', reason: 'Запрос задаёт направление исследования' } });
const read = () => ({ decision: 'Добавить проверку лимита', evidence: [], uncertainties: ['Неизвестно, проверяют ли лимит выше'],
  next: { action: 'read', path: 'a.ts', offset: 1, limit: 20, reason: 'Проверить существующее поведение' } });
const hooks = (): ExecHooks => ({ onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, by: 'policy', updatedInput: null }), onToolResult() {},
  onAskHuman: async () => ({}), onRecord: () => '' });

test('structured checkpoints on all seven stages use line references and runtime quotes', async t => {
  for (const stage of STAGE_ORDER) {
    const f = setup(t, [{ ...ready(), evidence: [{ source: 'request-1', lines: [1, 1] }] }]);
    f.req.prompt = { ...f.req.prompt, guidedProtocol: true, user: JSON.stringify({ data: { requests: ['Проверить лимит'] } }) };
    const result = await checkStageDecision(f.req, f.hooks, { ...f.options, stage });
    assert.equal(result.ok, true, result.note); assert.equal(f.records[0]!.evidence[0]!.quote, 'Проверить лимит');
    assert.ok(Number(f.requests[0]!.params?.max_tokens) >= 4096);
    const input = JSON.parse(f.requests[0]!.messages[1]!.content);
    assert.equal(input.sources['request-1'].chunks[0].firstLine, 1);
  }
});

test('hidden repeated text cannot authenticate a citation to unshown line numbers', async t => {
  const request = ['same fact', ...Array.from({ length: 5000 }, () => 'irrelevant filler'), 'same fact', ...Array.from({ length: 5000 }, () => 'irrelevant filler')].join('\n');
  const f = setup(t, [{ ...ready(), evidence: [{ source: 'request-1', lines: [5002, 5002] }] }]);
  f.req.prompt = { ...f.req.prompt, guidedProtocol: true, user: JSON.stringify({ data: { requests: [request] } }) };
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, false); assert.match(result.note, /показанном источнике/);
});

test('a complete shown range longer than eight lines is valid evidence', async t => {
  const request = Array.from({ length: 12 }, (_, i) => `Требование ${i + 1}`).join('\n');
  const f = setup(t, [{ ...ready(), evidence: [{ source: 'request-1', lines: [1, 12] }] }]);
  f.req.prompt = { ...f.req.prompt, guidedProtocol: true, user: JSON.stringify({ data: { requests: [request] } }) };
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, true, result.note); assert.equal(f.records[0]!.evidence[0]!.quote, request);
  const source = JSON.parse(f.requests[0]!.messages[1]!.content).sources['request-1'];
  assert.deepEqual(source.chunks[0].lines[11], { number: 12, content: 'Требование 12' });
});

test('lookup reason records the missing data without requiring duplicate text', async t => {
  const first = { ...read(), uncertainties: [] };
  const f = setup(t, [first, { ...ready(), evidence: [{ source: 'lookup-1', quote: 'checkLimit(config.old)' }] }]);
  writeFileSync(join(f.root, 'a.ts'), 'checkLimit(config.old);\n');
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, true, result.note); assert.deepEqual(f.records[0]!.uncertainties, [first.next.reason]);
});
function setup(t: TestContext, replies: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'decision-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records: StageDecisionCheck[] = []; const requests: ChatRequest[] = [];
  const provider: ChatProvider = { name: 'test', async chat(req) {
    requests.push(req);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { text: JSON.stringify(reply), toolCalls: [], finishReason: 'end_turn', usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 } };
  } };
  const req: Pick<ExecRequest, 'cwd' | 'model' | 'prompt' | 'allowedTools' | 'signal' | 'maxTurns' | 'maxBudgetUsd'> = {
    cwd: root, model: 'test', prompt: { system: '', user: 'Проверить лимит', tools: [], presetNote: null, editedByOperator: false },
    allowedTools: ['Read', 'Grep', 'AskHuman'], signal: new AbortController().signal, maxTurns: 8, maxBudgetUsd: null,
  };
  const options = { stage: 'plan' as const, provider, params: null, contextWindow: 16384, spent: () => 0, record: (entry: StageDecisionCheck) => records.push(entry) };
  return { root, records, requests, req, options, hooks: hooks() };
}

test('all seven stages can confirm a grounded first decision in one short request', async t => {
  for (const stage of STAGE_ORDER) {
    const f = setup(t, [ready()]);
    const result = await checkStageDecision(f.req, f.hooks, { ...f.options, stage });
    assert.equal(result.ok, true); assert.equal(result.modelRequests, 1);
    assert.equal(f.records[0]!.changed, false); assert.equal(f.records[0]!.status, 'ready');
    assert.ok(stageDecisionInstructions(stage).includes(stage));
  }
});

test('new source evidence corrects the first decision and is forwarded to the executor', async t => {
  const second = { ...ready('Исправить источник конфигурации'), evidence: [{ source: 'lookup-1', quote: 'checkLimit(config.old)' }] };
  const f = setup(t, [read(), second]); writeFileSync(join(f.root, 'a.ts'), 'checkLimit(config.old);\n');
  const used: string[] = [];
  f.hooks.onToolRequest = async (_call, meta) => { used.push(meta.toolName); return { allowed: true, by: 'policy', updatedInput: null }; };
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, true); assert.equal(result.modelRequests, 2); assert.equal(result.usage.inputTokens, 20);
  assert.deepEqual(used, ['Read']); assert.equal(f.records[1]!.changed, true);
  assert.match(result.block!, /checkLimit\(config.old\)/);
  assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), 'checkLimit(config.old);\n');
});

test('fabricated evidence cannot authorize proceeding', async t => {
  const f = setup(t, [{ ...ready(), evidence: [{ source: 'stage-input', quote: 'Тесты прошли' }] }]);
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, false); assert.equal(f.requests.length, 2); assert.match(result.note, /Основание отсутствует/);
  assert.equal(f.records.at(-1)!.status, 'blocked');
});

test('proceed with unresolved material uncertainty is rejected', async t => {
  const f = setup(t, [{ ...ready(), uncertainties: ['Неизвестно бизнес-правило'] }]);
  assert.equal((await checkStageDecision(f.req, f.hooks, f.options)).ok, false);
});

test('a repeated read without a new input stops instead of looping', async t => {
  const f = setup(t, [read()]); writeFileSync(join(f.root, 'a.ts'), 'one\n');
  let reads = 0; f.hooks.onToolRequest = async () => { reads++; return { allowed: true, by: 'policy', updatedInput: null }; };
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, false); assert.equal(reads, 1); assert.match(result.note, /нового входа/);
});

test('changing a range or spelling of the same file does not make identical data new', async t => {
  const first = read(); const second = { ...read(), next: { ...read().next, path: process.platform === 'win32' ? './A.ts' : './a.ts', limit: 21 } };
  const f = setup(t, [first, second]); writeFileSync(join(f.root, 'a.ts'), 'one\n');
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, false); assert.equal(result.modelRequests, 2);
  assert.match(result.note, /не добавил нового входа/);
});

test('large stage input can be read by page without overflowing compact execution context', async t => {
  const hidden = 'Точное правило в середине большого плана';
  const input = 'Проверить лимит\n' + 'x'.repeat(32000) + hidden + 'y'.repeat(32000);
  const offset = input.indexOf(hidden);
  const page = { ...read(), next: { action: 'input', source: 'stage-input', offset, limit: hidden.length, reason: 'Дочитать существенное правило' } };
  const f = setup(t, [page, { ...ready(), evidence: [{ source: 'lookup-1', quote: hidden }] }]);
  const result = await checkStageDecision({ ...f.req, prompt: { ...f.req.prompt, user: input } }, f.hooks, f.options);
  assert.equal(result.ok, true); assert.equal(result.modelRequests, 2);
  assert.match(result.block!, /Точное правило/); assert.ok(result.block!.length < 2000);
  assert.ok(f.requests.every(r => Buffer.byteLength(JSON.stringify(r.messages)) < 50000));
  assert.match(f.requests[0]!.messages[1]!.content!, /показан фрагментами/);
});

test('a citation in an unseen part of the input is rejected until it has been paged', async t => {
  const f = setup(t, [{ ...ready(), evidence: [{ source: 'stage-input', quote: 'НЕПОКАЗАННОЕ ПРАВИЛО' }] }]);
  const input = 'a'.repeat(32000) + 'НЕПОКАЗАННОЕ ПРАВИЛО' + 'b'.repeat(32000);
  const result = await checkStageDecision({ ...f.req, prompt: { ...f.req.prompt, user: input } }, f.hooks, f.options);
  assert.equal(result.ok, false); assert.match(result.note, /показанном источнике/);
});

test('engineering questions and duplicate business choices cannot reach the human channel', async t => {
  for (const next of [
    { action: 'question', question: 'Как оформить комментарий?', reason: 'Нет стиля', options: ['Кратко', 'Подробно'] },
    { action: 'question', question: 'Какой лимит?', reason: 'Нет правила', options: ['300', ' 300 '] },
  ]) {
    const f = setup(t, [{ ...read(), next }]); let asked = 0;
    f.hooks.onAskHuman = async () => { asked++; return { rule: ['300'] }; };
    assert.equal((await checkStageDecision(f.req, f.hooks, { ...f.options, stage: 'ask' })).ok, false);
    assert.equal(asked, 0);
  }
});

test('denied lookup is final and does not execute or ask again', async t => {
  const f = setup(t, [read()]); let results = 0;
  f.hooks.onToolRequest = async () => ({ allowed: false, by: 'operator', reason: 'Не читать', updatedInput: null });
  f.hooks.onToolResult = () => results++;
  const result = await checkStageDecision(f.req, f.hooks, f.options);
  assert.equal(result.ok, false); assert.equal(f.requests.length, 1); assert.equal(results, 1);
  assert.equal(f.records.at(-1)!.reason, 'Не читать');
});

test('permission edits determine which source is actually read', async t => {
  const f = setup(t, [read(), { ...ready(), evidence: [{ source: 'lookup-1', quote: 'edited-source' }] }]);
  writeFileSync(join(f.root, 'b.ts'), 'edited-source\n');
  f.hooks.onToolRequest = async () => ({ allowed: true, by: 'operator', updatedInput: { file_path: 'b.ts', offset: 1, limit: 20 } });
  assert.equal((await checkStageDecision(f.req, f.hooks, f.options)).ok, true);
  assert.match(f.records[0]!.observation!.text, /edited-source/);
});

test('actual business answer becomes evidence; empty answer blocks', async t => {
  const question = { ...read(), next: { action: 'question', question: 'Какой лимит?', reason: 'Нет бизнес-правила', options: ['300', '600'] } };
  const f = setup(t, [question, { ...ready(), evidence: [{ source: 'lookup-1', quote: '300' }] }]);
  f.hooks.onAskHuman = async call => {
    assert.equal(call.kind, 'ask_human');
    if (call.kind !== 'ask_human') throw new Error('Неверный вызов');
    assert.equal(call.questions[0]!.question, question.next.question);
    assert.match(closeGuidedQuestions('- [ ] [блокирующий] Какой лимит?', new Map([[questionKey(call.questions[0]!.question), '300']])), /\[x\]/);
    return { rule: ['300'] };
  };
  assert.equal((await checkStageDecision(f.req, f.hooks, { ...f.options, stage: 'ask' })).ok, true);
  const empty = setup(t, [question]);
  assert.equal((await checkStageDecision(empty.req, empty.hooks, empty.options)).ok, false);
});

test('a new business rule during implementation requires returning to preparation', async t => {
  const f = setup(t, [{ ...read(), next: { action: 'question', question: 'Какой лимит?', reason: 'Нет правила', options: ['300', '600'] } }]);
  let asked = false; f.hooks.onAskHuman = async () => { asked = true; return {}; };
  const result = await checkStageDecision(f.req, f.hooks, { ...f.options, stage: 'chunk' });
  assert.equal(result.ok, false); assert.equal(asked, false); assert.match(result.note, /возврата к ask/);
});

test('budget and context exhaustion block before any model request', async t => {
  const f = setup(t, [ready()]);
  assert.equal((await checkStageDecision({ ...f.req, maxTurns: 1 }, f.hooks, f.options)).ok, false);
  assert.equal((await checkStageDecision({ ...f.req, maxBudgetUsd: 1 }, f.hooks, { ...f.options, spent: () => 1 })).ok, false);
  assert.equal((await checkStageDecision(f.req, f.hooks, { ...f.options, contextWindow: 500 })).ok, false);
  assert.equal(f.requests.length, 0);
});

test('cancellation after response blocks tools and provider failures retain classification', async t => {
  const f = setup(t, [read()]); const aborter = new AbortController();
  const original = f.options.provider.chat;
  f.options.provider.chat = async req => { const response = await original(req); aborter.abort(new Error('cancelled')); return response; };
  let touched = false; f.hooks.onToolRequest = async () => { touched = true; return { allowed: true, by: 'policy', updatedInput: null }; };
  await assert.rejects(checkStageDecision({ ...f.req, signal: aborter.signal }, f.hooks, f.options), /cancelled/);
  assert.equal(touched, false);
  const failed = setup(t, [new ProviderEnvError('offline')]);
  await assert.rejects(checkStageDecision(failed.req, failed.hooks, failed.options), ProviderEnvError);
});
