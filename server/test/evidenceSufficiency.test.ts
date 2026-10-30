import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedExecutor } from '../src/exec/GuidedExecutor.ts';
import { attachMissingClaimEvidence, buildGuidedWorkingContext, guidedEvidenceProblems, missingEvidencePaths, supplementGuidedDecisionEvidence, validateGuidedDecisionEvidence } from '../src/exec/guidedWorkingContext.ts';
import { initGuided } from '../src/run/guidedState.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

const hooks = (): ExecHooks => ({ onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {},
  onAskHuman: async () => ({}), onRecord: () => '' });
const request = (root: string): ExecRequest => ({ cwd: root, model: 'test', allowedTools: ['Read', 'Write', 'Edit'], signal: new AbortController().signal,
  maxTurns: 5, maxBudgetUsd: null, prompt: { presetNote: null, system: '', user: 'task', tools: [], editedByOperator: false, guidedProtocol: true },
  readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null, guidedEngineVersion: 5 });
const item = (file: string) => ({ id: 'work-1', title: 'change', files: [file], claims: ['claim-1'], dependsOn: [], prediction: 'checked', checks: ['check'], status: 'pending' as const, attempts: 0, repartitioned: false });
const requirements = JSON.stringify({ acceptance: [{ id: 'claim-1', behavior: 'Requested behavior', procedure: 'Exercise it', expected: 'Observed result' }] });

function rootWith(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'evidence-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('missing dependency blocks before a model call and returns a typed Explore failure', async t => {
  const root = rootWith(t);
  writeFileSync(join(root, 'a.ts'), "import { b } from './b.ts'; export const a = b;\n");
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  const paths = new WitokPaths(root, 'case'); initGuided(paths, 'local:test', 5);
  let calls = 0;
  const provider: ChatProvider = { name: 'script', async chat() { calls++; return { text: '{}', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() }; } };
  const executor = new GuidedExecutor({ paths, provider, items: [item('a.ts')], inputRevision: () => 'r1', requirements, sources: '', contextWindow: 16000,
    workingContext: (files, tasks) => buildGuidedWorkingContext(root, files, tasks, new Set()), check: async () => ({ passed: true, result: 'ok' }) });
  const result = await executor.run(request(root), hooks());
  assert.equal(result.ok, false);
  assert.equal(result.failure?.retryStage, 'explore');
  assert.equal(calls, 0);
  assert.match(result.note, /b\.ts/);
});

test('partial existing target blocks while an explicitly new file is actionable with claim evidence', async t => {
  const partialRoot = rootWith(t);
  writeFileSync(join(partialRoot, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  const partial = buildGuidedWorkingContext(partialRoot, ['a.ts'], [{ file: 'a.ts', symbol: null, action: 'change', claims: ['claim-1'] }], new Set(), '', 20);
  assert.ok(guidedEvidenceProblems(partial).some(problem => problem.includes('partial')));

  const root = rootWith(t);
  const paths = new WitokPaths(root, 'case'); initGuided(paths, 'local:test', 5);
  let calls = 0;
  const provider: ChatProvider = { name: 'script', async chat(req) {
    calls++;
    const input = JSON.parse(req.messages[1]!.content);
    const context = input.workingContext;
    assert.equal(input.sources, undefined);
    assert.equal(input.responseSchema, undefined);
    assert.deepEqual(Object.keys(input.item).sort(), ['claims', 'files', 'id', 'prediction', 'title']);
    assert.ok(Array.isArray(input.fileTasks));
    assert.ok((req.params?.response_format as any)?.json_schema.schema);
    assert.equal(context.requirements.find((value: any) => value.kind === 'target').status, 'not-applicable');
    const evidenceIds = context.requirements.filter((value: any) => value.kind === 'claim').flatMap((value: any) => value.evidenceIds);
    return { text: JSON.stringify({ action: 'patch', prediction: 'created', evidenceIds, ops: [{ op: 'create_file_ir', module: { version: 1,
      body: [{ kind: 'variable_declaration', declarationKind: 'const', name: 'created', initializer: { kind: 'literal', value: true }, export: true }] } }] }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  } };
  const executor = new GuidedExecutor({ paths, provider, items: [item('new.ts')], inputRevision: () => 'r1', requirements, sources: '', contextWindow: 16000,
    workingContext: (files, tasks) => buildGuidedWorkingContext(root, files, tasks, new Set()), check: async () => ({ passed: true, result: 'ok' }) });
  const result = await executor.run(request(root), hooks());
  assert.equal(result.ok, true, result.note);
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(root, 'new.ts'), 'utf8'), 'export const created = true;\n');
});

test('intermediate operations and the latest check are mandatory bound evidence for repair', () => {
  const context = supplementGuidedDecisionEvidence({ fragments: [], imports: [], missing: [], hashes: {}, partial: false, requirements: [], decisionEvidence: [] }, {
    claims: [{ id: 'claim-1', text: 'behavior' }], intermediateState: [{ op: 'insert_after', body: 'previous draft' }], latestCheck: 'actual failure',
  });
  const claim = context.requirements.find(value => value.kind === 'claim')!.evidenceIds[0]!;
  assert.throws(() => validateGuidedDecisionEvidence({ action: 'patch', evidenceIds: [claim] }, context), /intermediate-state/);
  const all = context.decisionEvidence.map(value => value.id);
  assert.doesNotThrow(() => validateGuidedDecisionEvidence({ action: 'patch', evidenceIds: all }, context));
  assert.throws(() => validateGuidedDecisionEvidence({ action: 'patch', evidenceIds: [...all, 'invented.ts:12'] }, context), /evidenceId/);
});

test('missing claim evidence is attached when other packet ids are already cited', () => {
  const context = supplementGuidedDecisionEvidence({ fragments: [], imports: [], missing: [], hashes: {}, partial: false, requirements: [], decisionEvidence: [] }, {
    claims: [{ id: 'claim-1', text: 'behavior' }, { id: 'claim-2', text: 'edge' }],
  });
  const claim = context.requirements.find(value => value.kind === 'claim')!.evidenceIds[0]!;
  const target = { id: 'evidence-target-abc', kind: 'target' as const, hash: 'h', path: 'src/a.ts' };
  context.decisionEvidence.push(target);
  context.requirements.push({ id: 'requirement-target', kind: 'target', status: 'ready', path: 'src/a.ts', claimIds: ['claim-1'], evidenceIds: [target.id], reason: 'target ready' });
  assert.throws(() => validateGuidedDecisionEvidence({ action: 'patch', evidenceIds: [target.id] }, context), /claim/);
  const attached = attachMissingClaimEvidence({ action: 'patch' as const, evidenceIds: [target.id] }, context);
  assert.deepEqual(attached.evidenceIds, [target.id, claim]);
  assert.doesNotThrow(() => validateGuidedDecisionEvidence(attached, context));
});

test('missing intermediate-state evidence is attached like claim evidence', () => {
  const context = supplementGuidedDecisionEvidence({ fragments: [], imports: [], missing: [], hashes: {}, partial: false, requirements: [], decisionEvidence: [] }, {
    claims: [{ id: 'claim-1', text: 'behavior' }],
    intermediateState: { kind: 'conflict', detail: 'x' },
  });
  const claim = context.requirements.find(value => value.kind === 'claim')!.evidenceIds[0]!;
  const intermediate = context.requirements.find(value => value.kind === 'intermediate-state')!.evidenceIds[0]!;
  const attached = attachMissingClaimEvidence({ action: 'patch' as const, evidenceIds: [claim] }, context);
  assert.ok(attached.evidenceIds?.includes(claim));
  assert.ok(attached.evidenceIds?.includes(intermediate));
  assert.doesNotThrow(() => validateGuidedDecisionEvidence(attached, context));
});

test('a dependency omitted by the context budget remains a blocking partial requirement', t => {
  const root = rootWith(t);
  const source = "import { b } from './b.ts'; export function a() { return b; }\n";
  writeFileSync(join(root, 'a.ts'), source);
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  const targetLength = source.slice(source.indexOf('export function')).length;
  const context = buildGuidedWorkingContext(root, ['a.ts'], [{ file: 'a.ts', symbol: 'a', action: 'change a', claims: ['claim-1'] }], new Set(['b.ts']), '', targetLength);
  assert.equal(context.requirements.find(value => value.kind === 'target')?.status, 'ready');
  assert.ok(guidedEvidenceProblems(context).some(problem => problem.includes('b.ts') && problem.includes('partial')));
});

test('dynamic imports stay uncertain and unsupported languages use file evidence rather than invented symbols', t => {
  const root = rootWith(t);
  writeFileSync(join(root, 'a.ts'), "export async function load() { return import('./plugin.ts'); }\n");
  writeFileSync(join(root, 'plugin.ts'), 'export const plugin = true;\n');
  const dynamic = buildGuidedWorkingContext(root, ['a.ts'], [{ file: 'a.ts', symbol: 'load', action: 'change loader', claims: ['claim-1'] }], new Set(['plugin.ts']));
  assert.ok(dynamic.requirements.some(value => value.kind === 'dependency' && value.status === 'uncertain' && value.evidenceIds.length > 0));
  assert.equal(guidedEvidenceProblems(dynamic).length, 0, 'explicit uncertainty with fresh source evidence must not cause an endless Explore loop');

  writeFileSync(join(root, 'script.py'), 'def run():\n    return 1\n');
  const python = buildGuidedWorkingContext(root, ['script.py'], [{ file: 'script.py', symbol: 'run', action: 'change run', claims: ['claim-1'] }], new Set());
  const target = python.requirements.find(value => value.kind === 'target');
  assert.equal(target?.status, 'ready');
  assert.ok(python.fragments.some(value => value.role === 'target' && value.symbol === null && value.text.includes('def run')));
});

test('missingEvidencePaths lists unread dependency and consumer paths for hydrate', t => {
  const root = rootWith(t);
  writeFileSync(join(root, 'a.ts'), "import { b } from './b.ts'; export function a() { return b; }\n");
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(root, 'consumer.ts'), "import { a } from './a.ts'; export const x = a();\n");
  const tasks = [{ file: 'a.ts', symbol: 'a', action: 'change a', claims: ['claim-1'] }];
  const unseen = buildGuidedWorkingContext(root, ['a.ts'], tasks, new Set(), '', 14000, true);
  const pending = missingEvidencePaths(unseen);
  assert.ok(pending.includes('b.ts'));
  assert.ok(pending.includes('consumer.ts'));
  const hydrated = buildGuidedWorkingContext(root, ['a.ts'], tasks, new Set(pending), '', 14000, true);
  assert.equal(guidedEvidenceProblems(hydrated).length, 0);
});

test('dynamic consumers through aliases are explicit uncertainty, never proven absence', t => {
  const root = rootWith(t);
  writeFileSync(join(root, 'feature.ts'), 'export const feature = 1;\n');
  writeFileSync(join(root, 'consumer.ts'), "export const load = () => import('@/feature');\n");
  const tasks = [{ file: 'feature.ts', symbol: 'feature', action: 'change feature', claims: ['claim-1'] }];
  const unseen = buildGuidedWorkingContext(root, ['feature.ts'], tasks, new Set(), '', 14000, true);
  assert.ok(guidedEvidenceProblems(unseen).some(problem => problem.includes('consumer.ts')));
  const observed = buildGuidedWorkingContext(root, ['feature.ts'], tasks, new Set(['consumer.ts']), '', 14000, true);
  assert.ok(observed.requirements.some(value => value.kind === 'consumer' && value.status === 'uncertain' && value.reason.includes('alias') && value.evidenceIds.length > 0));
  writeFileSync(join(root, 'comment.ts'), "// import('@/feature')\n// from '@/feature'\nconst text = \"import('@/feature')\";\n");
  const comments = buildGuidedWorkingContext(root, ['feature.ts'], tasks, new Set(['consumer.ts', 'comment.ts']), '', 14000, true);
  assert.equal(comments.requirements.some(value => value.path === 'comment.ts'), false);
});
