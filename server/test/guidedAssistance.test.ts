import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import type { WorkItem } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initGuided, guidedSummary } from '../src/run/guidedState.ts';
import { GuidedWorkloadStore, readGuidedWorkload } from '../src/run/guidedWorkload.ts';
import { packGuidedFieldQuestion } from '../src/exec/guidedContext.ts';
import { materializeCompactPlan, guidedCompactPlanResponseFormat, compactPlanRepairFormat, materializeCompactRepair, guidedPlanRepairResponseFormat } from '../src/exec/GuidedPlanExecutor.ts';
import { GuidedExecutor, parseBoundGuidedReply, guidedBoundActionResponseFormat } from '../src/exec/GuidedExecutor.ts';
import { parseRepairDiagnosis, repairDiagnosisTargets } from '../src/exec/repairDiagnosis.ts';
import { AXES } from '../src/artifacts/planAxes.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

test('context trimming keeps exact predicates, cited facts and authoritative artifacts or fails before asking', () => {
  const critical = 'Required final condition\n'.repeat(20);
  const data = { input: { data: { requests: [critical], artifacts: [
    { path: 'intent.md', content: critical }, { path: 'journal.md', content: 'optional evidence '.repeat(3000) },
  ] } }, answerRequirements: critical, sourceFacts: [critical], currentFacts: [critical] };
  const before = structuredClone(data);
  const packed = packGuidedFieldQuestion('JSON only', 'x', 'Question', data, 4096, { protectContract: true });
  assert.equal(packed.truncated, true); assert.deepEqual(packed.data.sourceFacts, data.sourceFacts);
  assert.equal(packed.data.answerRequirements, critical); assert.deepEqual(packed.data.currentFacts, data.currentFacts);
  assert.equal(JSON.stringify(packed.data).includes(JSON.stringify(critical)), true); assert.deepEqual(data, before);
  assert.throws(() => packGuidedFieldQuestion('JSON only', 'x', 'Question', data, 512, { protectContract: true }), /Обязательный контракт/);
});

test('compact Plan supplies ordered identities without asking the model to reproduce runtime facts', () => {
  const compact = { approach: 'Use existing source', steps: [{ file: 'a.ts', symbol: 'n', action: 'return one', claims: ['claim-1'],
    check: 'call n', expected: 'one', contract: 'preserve API', dependsOn: [] }], excluded: [],
    axes: AXES.map(() => ({ affected: false, reason: 'unchanged', outcome: 'н/п — unchanged' })), changes: 'none', callers: [] };
  const plan = materializeCompactPlan(compact);
  assert.equal(plan.steps[0]!.id, 1); assert.deepEqual(plan.axes.map(axis => axis.name), AXES);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(plan).length);
  assert.throws(() => materializeCompactPlan({ ...compact, steps: [{ ...compact.steps[0], id: 99 }] }), /Unrecognized key/);
  const format = guidedCompactPlanResponseFormat(['claim-1'], ['n']) as any;
  assert.equal('id' in format.json_schema.schema.properties.steps.items.properties, false);
  const callerFacts = [{ symbol: 'a.ts:n', callers: [{ path: 'b.ts', line: 3, symbol: 'use' }] }];
  const withCallers = materializeCompactPlan({ ...compact, callers: [{ decision: 'compatible without edits' }] }, callerFacts);
  assert.equal(withCallers.callers[0]!.caller, 'b.ts:3 (use)');
  assert.throws(() => materializeCompactPlan(compact, callerFacts), /всех известных/);
  const repaired = materializeCompactRepair({ steps: [{ ...compact.steps[0], id: 1 }], removeSteps: [], approach: null, axes: null, excluded: null, changes: null, callers: null }) as any;
  assert.equal(repaired.steps[0].isNew, false);
  const repairFormat = compactPlanRepairFormat(guidedPlanRepairResponseFormat(['claim-1'], [1])) as any;
  assert.equal('isNew' in repairFormat.json_schema.schema.properties.steps.items.properties, false);
});

test('bound Chunk operations cannot substitute the selected file', () => {
  const value = { action: 'patch', prediction: 'one', ops: [{ op: 'delete', symbol: 'n' }] };
  assert.deepEqual(parseBoundGuidedReply(JSON.stringify(value), 'a.ts'), { ...value, ops: [{ ...value.ops[0], file: 'a.ts' }] });
  assert.throws(() => parseBoundGuidedReply(JSON.stringify({ ...value, ops: [{ ...value.ops[0], file: 'foreign.ts' }] }), 'a.ts'), /закреплён/);
  assert.doesNotThrow(() => guidedBoundActionResponseFormat([{ path: 'a.ts', hash: 'old', symbols: ['n'], isNew: false }]));
});

test('test diagnosis must cite observed failure and source; it never authorizes existing tests', () => {
  const diagnosis = { kind: 'test-expectation', reason: 'source requires one', observedFailure: 'actual 1 expected 2', source: { request: 1, lines: [1, 1] } };
  const parsed = parseRepairDiagnosis(JSON.stringify(diagnosis), 'FAIL actual 1 expected 2', ['Return one']);
  assert.deepEqual(repairDiagnosisTargets(parsed, ['src/n.ts', 'test/new.test.ts', 'test/old.test.ts'], ['test/new.test.ts']), ['test/new.test.ts']);
  assert.throws(() => parseRepairDiagnosis(JSON.stringify({ ...diagnosis, observedFailure: 'invented error' }), 'actual 1 expected 2', ['Return one']), /фактический/);
  assert.throws(() => parseRepairDiagnosis(JSON.stringify({ ...diagnosis, source: null }), 'actual 1 expected 2', ['Return one']), /основание/);
});

for (const mode of ['test-expectation', 'unknown'] as const) test(`v4 diagnoses ${mode} before repair and persists workload across resume`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-assistance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'test'); initGuided(paths, 'local:test', 4);
  let time = 1000; const workload = new GuidedWorkloadStore(paths, () => time); workload.start();
  const hooks: ExecHooks = { onText() {}, onThinking() {}, onWarn() {}, onFriction() {}, onToolResult() {}, onRecord: () => '',
    onUsage: (usage, duration, work) => workload.usage(usage, duration, work), onHarnessEvent: event => workload.event(event),
    onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onAskHuman: async () => ({}) };
  let calls = 0;
  const provider: ChatProvider = { name: 'fixture', async chat(request) {
    calls++; time += 10;
    const data = JSON.parse(request.messages[1]!.content);
    const format = (request.params?.response_format as any)?.json_schema.name;
    const value = format === 'guided_failure_diagnosis' ? { kind: mode, reason: 'The request requires one', observedFailure: 'actual 1 expected 2',
      source: mode === 'unknown' ? null : { request: 1, lines: [1, 1] } } : { action: 'patch', prediction: 'one', ops: [{ op: 'create_file',
      body: data.targetFile === 'src/n.ts' ? 'export const n = 1;\n' : `export const expected = ${calls < 3 ? 2 : 1};\n` }] };
    return { text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn', usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 } };
  } };
  const files = ['src/n.ts', 'test/n.test.ts'];
  const item: WorkItem = { id: 'work-1', title: 'Return one', files, claims: ['claim-1'], dependsOn: [], prediction: 'one', checks: ['test'],
    status: 'pending', attempts: 0, repartitioned: false };
  const req: ExecRequest = { cwd: root, model: 'fixture', guidedEngineVersion: 4, allowedTools: ['Read', 'Write', 'Edit'],
    maxTurns: 10, maxBudgetUsd: null, signal: new AbortController().signal, prompt: { system: '', user: '' } as ExecRequest['prompt'],
    readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null };
  const result = await new GuidedExecutor({ paths, provider, items: [item], inputRevision: () => 'same', originalRequests: ['Return one'],
    requirements: '', sources: '', contextWindow: 8192, draftPerFile: true, writableFiles: files,
    check: async () => readFileSync(join(root, files[1]!), 'utf8').includes('= 2') ? { passed: false, result: 'actual 1 expected 2' } : { passed: true, result: 'passes' },
  }).run(req, hooks);
  assert.equal(result.ok, mode === 'test-expectation', result.note); assert.equal(calls, mode === 'test-expectation' ? 4 : 3);
  if (mode === 'test-expectation') {
    assert.equal(readFileSync(join(root, files[0]!), 'utf8'), 'export const n = 1;\n');
    assert.equal(readFileSync(join(root, files[1]!), 'utf8'), 'export const expected = 1;\n');
  } else assert.equal(existsSync(join(root, files[0]!)), false, 'an unresolved diagnosis rolls back the transaction');
  const metrics = guidedSummary(paths)!.workload!;
  assert.equal(metrics.byPurpose.proposal.requests, 2); assert.equal(metrics.byPurpose.review.requests, 1);
  assert.equal(metrics.byPurpose['semantic-repair'].requests, mode === 'test-expectation' ? 1 : 0);
  assert.equal(metrics.firstMutation?.requests, 2); assert.equal(metrics.firstMutation?.elapsedMs, 20);
  new GuidedWorkloadStore(paths, () => time).start(); assert.deepEqual(readGuidedWorkload(paths), metrics);
});
