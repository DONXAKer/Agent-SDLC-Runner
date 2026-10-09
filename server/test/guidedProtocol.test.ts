import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage, STAGE_ORDER, type PreparedPrompt } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { documentFacts, guidedQuestion } from '../src/exec/guidedProtocol.ts';
import { guidedPrompt } from '../src/run/guidedPrompt.ts';
import { fillClaims } from '../src/run/claimFill.ts';
import { reviewByHunks } from '../src/run/reviewFill.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { contractLineFacts, sourceLineFacts, renderGuidedContractRepair } from '../src/exec/guidedIntentContract.ts';
import { parseIntentContractReview } from '../src/exec/intentContractReview.ts';
import { deriveClaimsBlind } from '../src/run/claimsBlind.ts';
import { validateGuidedPreparationAnswer } from '../src/run/preparationReview.ts';

test('document conversion removes forms and multiline comments while preserving literal code', () => {
  const code = 'const token = `x`; // **literal**';
  const facts = documentFacts(`<!-- internal\nKEEP HEADINGS\n-->\n# Report\n## Facts\n- **Name:** ready\n| Path | Fact |\n|---|---|\n| src/a.ts | observed |\n| ‹path› | ‹fact› |\n\n\`\`\`ts\n${code}\n\`\`\``);
  const json = JSON.stringify(facts);
  assert.ok(!json.includes('KEEP HEADINGS')); assert.ok(!json.includes('‹')); assert.ok(!json.includes('| Path'));
  assert.ok(json.includes('src/a.ts')); assert.ok(json.includes(code));
  assert.throws(() => documentFacts('```ts\nunfinished'), /Незавершённый/);
});

test('all seven stages receive permitted document facts without the screen prompt or templates', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-protocol-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'test'); mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.intent, '# Task\n## Goal\n- Actual requirement\n- ‹unknown›');
  writeFileSync(paths.plan, '# Plan\n## Steps\n- Actual step');
  writeFileSync(paths.clarificationReport, '# Answers\n- Human fact');
  const original: PreparedPrompt = { system: 'FILL THE MARKDOWN FORM', user: '| template | ‹slot› |', tools: [], presetNote: null, editedByOperator: false };
  for (const stage of STAGE_ORDER) {
    const prompt = guidedPrompt(stage, { paths, chunk: 1, attempt: 1 }, original, 'Original request');
    const input = JSON.parse(prompt.user);
    assert.equal(prompt.guidedProtocol, true); assert.equal(input.questionId, `${stage}:input`);
    assert.deepEqual(input.data.requests, ['Original request']);
    assert.ok(!prompt.user.includes('‹')); assert.ok(!prompt.user.includes('template')); assert.ok(!prompt.system.includes('FILL'));
    if (stage === 'verify') assert.ok(!input.data.artifacts.some((item: { path: string }) => item.path.includes('journal')));
  }
});

test('claim verification asks one JSON question per claim and runtime builds records', async () => {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = { name: 'test', async chat(req) {
    requests.push(req); const question = JSON.parse(req.messages[1]!.content);
    assert.ok(question.questionId.startsWith('claim:')); assert.equal(question.version, 1);
    return { text: JSON.stringify({ status: '✅', evidence: 'src/a.ts:count', fix: 'н/п' }), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const result = await fillClaims({ guided: true, provider, model: 'test', params: null, system: 'OLD MARKDOWN',
    claims: [{ id: 'claim-1', text: 'Counts' }, { id: 'claim-2', text: 'Exports' }], diff: 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+export const count = 1;',
    tests: 'passed', evidenceBudgetBytes: 8000, signal: new AbortController().signal });
  assert.equal(requests.length, 2); assert.equal(result.calls.length, 2);
  assert.ok(requests.every(req => !!req.params?.response_format && !req.messages[0]!.content.includes('OLD MARKDOWN')));
});

test('invalid review JSON cannot count as a completed clean review', async () => {
  let calls = 0;
  const provider: ChatProvider = { name: 'test', async chat(req) {
    calls++; assert.ok(JSON.parse(req.messages[1]!.content).questionId.startsWith('review:'));
    return { text: '{}', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const result = await reviewByHunks({ guided: true, provider, model: 'test', params: null, taskContext: 'Task',
    sourceHunks: [{ file: 'src/a.ts', text: 'export const count = 1;' }], diff: '', axes: [{ name: 'Конфигурация', affected: false, outcomeRaw: 'unchanged' }],
    hunkBudgetBytes: 8000, signal: new AbortController().signal });
  assert.equal(calls, 4); assert.equal(result.hunksAnswered, 0); assert.equal(result.axesAnswered, 0);
  assert.equal(result.hunksAsked, 1); assert.equal(result.axesAsked, 1);
});

test('question envelopes leave original user text unchanged', () => {
  const original = '# User text\n`const x = 1`';
  assert.equal(JSON.parse(guidedQuestion('x', '# Question', { original })).data.original, original);
});

test('contract repair receives numbered values and runtime renders tables and original citations', () => {
  const facts = contractLineFacts('\n| ID | Пункт |\n|---|---|\n| claim-1 | Behaviour |\n');
  assert.deepEqual(facts[1], { number: 4, value: { ID: 'claim-1', Пункт: 'Behaviour' } });
  const request = '# Original\nLiteral `code` | value';
  assert.equal(sourceLineFacts(request)[1]!.value, 'Literal `code` | value');
  const acceptance = renderGuidedContractRepair('Приёмочный лист', JSON.stringify({ section: 'Приёмочный лист',
    values: [{ id: 'claim-1', behavior: 'Behaviour', procedure: 'Run', expected: 'Pass' }] }), [request], ['claim-1']);
  assert.match(acceptance, /Процедура: Run\. Ожидаемо: Pass/);
  const basis = renderGuidedContractRepair('Основания и сценарии', JSON.stringify({ section: 'Основания и сценарии',
    values: [{ id: 'claim-1', basis: { file: 'request-1', lines: [2, 2] }, scenario: 'Input', counterexample: 'Wrong' }] }), [request], ['claim-1']);
  assert.ok(basis.includes('Literal `code`')); assert.ok(basis.includes('request-1:L2-L2'));
  assert.throws(() => renderGuidedContractRepair('Приёмочный лист', JSON.stringify({ section: 'Приёмочный лист',
    values: [{ id: 'claim-2', behavior: 'Behaviour', procedure: 'Run', expected: 'Pass' }] }), [request], ['claim-1']), /набор ID/);
});

test('guided contract review rejects out-of-source citations instead of silently clamping them', () => {
  const answer = JSON.stringify({ issues: [{ problem: 'Mismatch', quotes: [{ section: 'Что делаем', lines: [1, 99] }],
    source: { file: 'request-1', lines: [1, 1] } }] });
  assert.throws(() => parseIntentContractReview(answer, '## Что делаем\nBehaviour\n', ['Request'], true), /вне источника/);
});

test('independent guided claims use only structured inputs and runtime assigns numbers', async () => {
  const provider: ChatProvider = { name: 'test', async chat(req) {
    assert.equal(JSON.parse(req.messages[1]!.content).questionId, 'explore:blind-claims');
    assert.ok(!JSON.stringify(req.messages).includes('OLD MARKDOWN'));
    return { text: JSON.stringify({ claims: [{ text: 'Boundary', check: 'Use boundary input', tags: ['edge'] }] }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const result = await deriveClaimsBlind({ provider, model: 'test', params: null, system: 'OLD MARKDOWN',
    sections: { brief: '', why: '', doing: '', notDoing: '' }, indexBlock: 'OLD MARKDOWN', sources: 'OLD MARKDOWN',
    guidedData: { requests: ['Original'], sources: [{ path: 'a.ts', content: 'export const n = 1;' }] }, signal: new AbortController().signal });
  assert.equal(result.requestError, null); assert.equal(result.claims[0]!.n, 1); assert.deepEqual(result.claims[0]!.tags, ['edge']);
});

test('guided independent preparation review validates exact object schemas', () => {
  assert.doesNotThrow(() => validateGuidedPreparationAnswer('issues', '{"issues":[]}'));
  assert.throws(() => validateGuidedPreparationAnswer('issues', '{"issues":["unstructured defect"]}'));
  assert.throws(() => validateGuidedPreparationAnswer('scenarios', '{"scenarios":[],"extra":"wrong"}'));
});
