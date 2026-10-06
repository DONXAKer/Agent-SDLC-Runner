import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import type { WorkItem } from '@sdlc-runner/shared';
import type { PlanStep } from '../src/artifacts/planSteps.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import { ProviderEnvError } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { GuidedExecutor, guidedActionResponseFormat, parseGuidedReply, parseGuidedTurn, simulateOps, restoreTransaction } from '../src/exec/GuidedExecutor.ts';
import { GuidedOpError } from '../src/exec/symbolOps.ts';
import { accountGuidedTime, appendGuidedJournalFacts, guidedInputRevision, guidedImplementationHashes, guidedReviewContext, guidedSourceHunks, initGuided, readGuided, saveGuided, workItems } from '../src/run/guidedState.ts';
import { guidedRetryFiles, observedImplementationContext } from '../src/run/guidedExecutor.ts';
import { guidedRequiredImplementationPaths, guidedPlanResponseFormat, parseGuidedPlan, renderGuidedPlan, validateGuidedPlanCoverage, applyGuidedPlanRepair, incorporateRuntimePlanCards, assignGuidedPlanFileState, renumberGuidedPlan, guidedPlanRepairTargets, guidedPlanRepairResponseFormat, guidedDuplicateMerge, guidedPlanKnownImpactProblem, guidedPlanPublicApiClaims, guidedPlanDependencyClaims, guidedPlanSecurityClaims, guidedPlanFieldsProblem, archiveReplacedGuidedPlan, GuidedPlanExecutor } from '../src/exec/GuidedPlanExecutor.ts';
import { chunkScopeSignals } from '../src/run/stages/chunk/evidence.ts';
import { parseGuidedJson } from '../src/exec/guidedJson.ts';
import { addRequirementsHash, readRequirementsHash, resolvedRequirementsHash } from '../src/artifacts/resolvedRequirements.ts';
import { guidedFileResearchResponseFormat, GuidedExploreExecutor, renderGuidedResearch } from '../src/exec/GuidedExploreExecutor.ts';
import type { ExploreExecutorOptions } from '../src/exec/ExploreExecutor.ts';
import { guidedAskResponseFormat, GuidedAskExecutor, isPlaceholderGuidedQuestion } from '../src/exec/GuidedAskExecutor.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { extractHumanFacts } from '../src/artifacts/humanFacts.ts';
import { initializePreparation, preparation, savePreparation, preparationPlanEvidenceProblem, recordPreparationRead, recordPreparationImplementation, sourceHash, planContentHash } from '../src/artifacts/preparation.ts';
import { AXES } from '../src/artifacts/planAxes.ts';
import { guidedPlanTargetProblem, guidedPlanCallersProblem } from '../src/exec/GuidedPlanExecutor.ts';
import { extractExplicitSteps } from '../src/artifacts/planSteps.ts';

function fixture(t: TestContext): { root: string; paths: WitokPaths } {
  const root = mkdtempSync(join(tmpdir(), 'guided-test-'));
  t.after(() => {
    assert.ok(!relative(tmpdir(), root).startsWith('..'));
    rmSync(root, { recursive: true, force: true });
  });
  const paths = new WitokPaths(root, 'test');
  initGuided(paths, 'local:test');
  return { root, paths };
}
const item = (files: string[]): WorkItem => ({ id: 'work-1', title: 'add behavior', files,
  claims: ['claim-1'], dependsOn: [], prediction: 'tests pass', checks: ['tests'], status: 'pending', attempts: 0, repartitioned: false });
const hooks = (): ExecHooks => ({ onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {},
  onAskHuman: async () => ({}), onRecord: () => '' });
const request = (root: string): ExecRequest => ({ cwd: root, model: 'test', allowedTools: ['Read', 'Grep', 'Write', 'Edit'],
  signal: new AbortController().signal, maxTurns: 20, maxBudgetUsd: null,
  prompt: { system: '', user: '' } as ExecRequest['prompt'], readOnlyDirs: [], subagents: [], mcp: null,
  finishGuard: null, salvageFromText: null });
function provider(replies: unknown[]): ChatProvider {
  let i = 0;
  return { name: 'test', chat: async () => ({ text: JSON.stringify(replies[Math.min(i++, replies.length - 1)]), toolCalls: [],
    finishReason: 'end_turn', usage: emptyUsage() }) } as ChatProvider;
}

test('reject outside paths, foreign files and whole-file rewrites before writing', t => {
  const { root } = fixture(t);
  const before = 'export const n = 1;\n// retained\n';
  writeFileSync(join(root, 'a.ts'), before);
  assert.throws(() => simulateOps(root, ['a.ts'], [{ op: 'replace_body', file: '../outside.ts', symbol: 'n', body: 'export const n = 2;' }]), /вне/);
  assert.throws(() => simulateOps(root, ['b.ts'], [{ op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 2;' }]), /вне группы/);
  assert.throws(() => simulateOps(root, ['a.ts'], [{ op: 'create_file', file: 'a.ts', body: 'export const n = 2;' }]), /уже существует/);
  assert.throws(() => simulateOps(root, ['a.ts'], [{ op: 'replace_body', file: 'a.ts', symbol: 'missing', body: 'export const missing = 1;' }]), /не найден/);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), before);
});

test('ambiguous symbol names fail with qualified candidates instead of guessing', t => {
  const { root } = fixture(t);
  const before = 'class Left {\n  size() { return 1; }\n}\nclass Right {\n  size() { return 2; }\n}\n';
  writeFileSync(join(root, 'a.ts'), before);
  assert.throws(() => simulateOps(root, ['a.ts'], [{ op: 'replace_body', file: 'a.ts', symbol: 'size', body: 'return 3;' }]), (error: unknown) => {
    assert.ok(error instanceof GuidedOpError);
    assert.equal(error.diagnostic.kind, 'ambiguous_symbol');
    assert.equal(error.diagnostic.op, 'replace_body');
    assert.deepEqual(error.diagnostic.candidates, ['Left.size', 'Right.size']);
    return true;
  });
  const [proposal] = simulateOps(root, ['a.ts'], [{ op: 'replace_body', file: 'a.ts', symbol: 'Left.size', body: 'return 3;' }]);
  assert.ok(proposal?.after.includes('return 3;'));
  assert.ok(proposal?.after.includes('return 2;'), 'соседний класс не затронут');
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), before);
});

test('ensure_import merges with an existing import and insert_after anchors a new declaration', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'src'));
  const before = "import { a } from './mod.ts';\n\nexport function main() { return a; }\n";
  writeFileSync(join(root, 'src', 'commands.ts'), before);
  const [merged] = simulateOps(root, ['src/commands.ts'], [
    { op: 'ensure_import', file: 'src/commands.ts', from: './mod.ts', names: ['a', 'b'] }]);
  assert.equal((merged?.after.match(/from '\.\/mod\.ts'/gu) ?? []).length, 1);
  assert.ok(merged?.after.includes("import { a, b } from './mod.ts';"));
  const [deduped] = simulateOps(root, ['src/commands.ts'], [
    { op: 'ensure_import', file: 'src/commands.ts', from: './other.ts', names: ['c'] },
    { op: 'ensure_import', file: 'src/commands.ts', from: './other.ts', names: ['c'] }]);
  assert.equal((deduped?.after.match(/from '\.\/other\.ts'/gu) ?? []).length, 1);
  const [inserted] = simulateOps(root, ['src/commands.ts'], [
    { op: 'insert_after', file: 'src/commands.ts', anchor: 'main', body: 'export function helper() { return main(); }' }]);
  assert.ok(inserted !== undefined && inserted.after.indexOf('export function main') < inserted.after.indexOf('export function helper'));
  assert.equal(readFileSync(join(root, 'src', 'commands.ts'), 'utf8'), before);
});

test('guided plan rejects unknown symbols and forbidden existing test cards before normalization', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'store.test.ts'), '// existing test\n');
  const step = { id: 1, file: 'src/store.ts', isNew: false, symbol: 'serialize', action: 'change store',
    claims: ['claim-1'], check: 'roundtrip', expected: 'same data', contract: 'compatible', dependsOn: [] };
  const plan = { approach: 'Use inspected store', steps: [step], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'н/п — unchanged' })), changes: 'none', callers: [] };
  assert.equal(guidedPlanTargetProblem(plan, '', root), null, 'без списка известных символов проверка вхождения отключена');
  assert.match(guidedPlanTargetProblem(plan, '', root, ['parse']) ?? '', /шаг 1.*не входит в список известных символов/u);
  assert.equal(guidedPlanTargetProblem({ ...plan, steps: [{ ...step, symbol: 'новый: serializeV2' }] }, '', root, ['parse']), null);
  assert.equal(guidedPlanTargetProblem(plan, '', root, ['serialize']), null);
  const forbidden = { ...plan, steps: [{ ...step, file: 'test/store.test.ts' }] };
  const intent = '## Чего не делаем\nНе меняем существующие тесты.\n';
  assert.match(guidedPlanTargetProblem(forbidden, intent, root) ?? '', /шаг 1.*существующие тесты.*removeSteps/u);
  assert.equal(guidedPlanTargetProblem({ ...forbidden, steps: [{ ...forbidden.steps[0]!, file: 'test/new.test.ts', isNew: true }] }, intent, root), null);
});

test('action schema binds ops to file cards and their shown symbols', () => {
  const format = guidedActionResponseFormat([
    { path: 'a.ts', hash: 'abc123', symbols: ['n', 'Runner.run'], isNew: false },
    { path: 'b.ts', hash: 'missing', symbols: [], isNew: true }]) as any;
  const patch = format.json_schema.schema.oneOf.find((v: any) => v.properties.action.const === 'patch');
  const variants = patch.properties.ops.items.oneOf;
  const byOp = (op: string, file: string) => variants.find((v: any) => v.properties.op.const === op && v.properties.file.const === file);
  assert.deepEqual(byOp('replace_body', 'a.ts').properties.symbol.enum, ['n', 'Runner.run']);
  assert.ok(byOp('insert_after', 'a.ts'));
  assert.ok(byOp('insert_before', 'a.ts'));
  assert.ok(byOp('rename', 'a.ts'));
  assert.ok(byOp('delete', 'a.ts'));
  assert.ok(byOp('ensure_import', 'a.ts'));
  assert.equal(byOp('create_file', 'a.ts'), undefined, 'существующий файл нельзя перезаписать целиком');
  assert.ok(byOp('create_file', 'b.ts'));
  assert.equal(variants.filter((v: any) => v.properties.file.const === 'b.ts').length, 1, 'для нового файла доступен только create_file');
  assert.equal(patch.properties.prediction.maxLength, 600);
});

test('action schema never emits an empty symbol enum for Ollama compatibility', () => {
  const format = guidedActionResponseFormat([{ path: 'a.ts', hash: 'abc', symbols: [], isNew: false }]) as any;
  assert.ok(!JSON.stringify(format).includes('"enum":[]'));
  const patch = format.json_schema.schema.oneOf.find((v: any) => v.properties.action.const === 'patch');
  const variant = patch.properties.ops.items.oneOf.find((v: any) => v.properties.op.const === 'replace_body');
  assert.equal(variant.properties.symbol.enum, undefined);
  assert.equal(variant.properties.symbol.type, 'string');
  assert.ok(variant.properties.symbol.pattern);
  const owned = guidedActionResponseFormat([{ path: 'new.ts', hash: 'abc', symbols: ['n'], isNew: false, ownedNewContent: 'export const n = 1;' }]) as any;
  const ownedPatch = owned.json_schema.schema.oneOf.find((v: any) => v.properties.action.const === 'patch');
  assert.ok(ownedPatch.properties.ops.items.oneOf.some((v: any) => v.properties.op.const === 'create_file'));
});

test('axes repair requires six answers and freezes unrelated plan fields', () => {
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1], undefined, [], 'axes') as any;
  const props = format.json_schema.schema.properties;
  assert.equal(props.steps.maxItems, 0);
  assert.equal(props.removeSteps.maxItems, 0);
  assert.equal(props.axes.type, 'array');
  assert.equal(props.axes.minItems, 6);
  assert.equal(props.axes.maxItems, 6);
  assert.equal(props.approach.type, 'null');
  assert.equal(props.excluded.type, 'null');
});

test('caller map schema pre-fills rows from runtime facts', () => {
  const callerFacts = [{ symbol: 'src/index.ts:bill', callers: [
    { path: 'test/invoice.test.ts', line: 18, symbol: 'checkBill' },
    { path: 'src/cli.ts', line: 7, symbol: null }] }];
  const format = guidedPlanResponseFormat(['claim-1'], undefined, callerFacts) as any;
  const callers = format.json_schema.schema.properties.callers;
  assert.equal(callers.minItems, 2);
  assert.equal(callers.maxItems, 2);
  const rows = callers.items.oneOf;
  assert.deepEqual(rows.map((row: any) => [row.properties.symbol.const, row.properties.caller.const]), [
    ['src/index.ts:bill', 'test/invoice.test.ts:18 (checkBill)'], ['src/index.ts:bill', 'src/cli.ts:7']]);
  assert.deepEqual(rows[0].properties.covered.enum, ['да', 'нет']);
  assert.ok(!JSON.stringify(format).includes('"oneOf":[]'), 'пустой oneOf запрещён для Ollama');
  const empty = guidedPlanResponseFormat(['claim-1'], undefined, []) as any;
  assert.equal(empty.json_schema.schema.properties.callers.maxItems, 0);
});

test('caller decisions stay editable on step repairs and frozen on axes repairs', () => {
  const callerFacts = [{ symbol: 'a.ts:f', callers: [{ path: 'b.ts', line: 3, symbol: null }] }];
  const steps = guidedPlanRepairResponseFormat(['claim-1'], [1], undefined, [], 'steps', null, false, undefined, callerFacts) as any;
  assert.ok(steps.json_schema.schema.properties.callers.anyOf, 'ремонт шагов может править решения карты вызывающих');
  const target = guidedPlanRepairResponseFormat(['claim-1'], [1], ['a.ts'], [], 'target', null, false, undefined, callerFacts) as any;
  assert.ok(target.json_schema.schema.properties.callers.anyOf);
  const axes = guidedPlanRepairResponseFormat(['claim-1'], [1], undefined, [], 'axes', null, false, undefined, callerFacts) as any;
  assert.equal(axes.json_schema.schema.properties.callers.type, 'null');
  assert.ok(axes.json_schema.schema.required.includes('callers'));
});

test('caller map validation requires an addressed decision for every pre-filled caller', () => {
  const callerFacts = [{ symbol: 'src/index.ts:bill', callers: [
    { path: 'test/invoice.test.ts', line: 18, symbol: 'checkBill' },
    { path: 'src/cli.ts', line: 7, symbol: null }] }];
  const step = { id: 1, file: 'src/index.ts', isNew: false, symbol: 'bill', action: 'change bill', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: '`bill(total)` → `bill(total, zone)`', dependsOn: [] };
  const plan = { approach: 'change', steps: [step], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'r', outcome: 'o' })), changes: 'none', callers: [] as { symbol: string; caller: string; covered: 'да' | 'нет'; decision: string }[] };
  assert.match(guidedPlanCallersProblem(plan, callerFacts) ?? '', /шаг 1: src\/index\.ts:bill ← test\/invoice\.test\.ts:18 \(checkBill\): нет решения/u);
  const decided = { ...plan, steps: [step, { ...step, id: 2, file: 'src/cli.ts', contract: 'н/п — вызов обновлён', symbol: 'новый: main' }], callers: [
    { symbol: 'src/index.ts:bill', caller: 'test/invoice.test.ts:18 (checkBill)', covered: 'нет' as const, decision: 'zone имеет значение по умолчанию; вызов совместим без правок' },
    { symbol: 'src/index.ts:bill', caller: 'src/cli.ts:7', covered: 'да' as const, decision: 'передаёт zone' }] };
  assert.equal(guidedPlanCallersProblem(decided, callerFacts), null);
  const wrongScope = { ...decided, callers: [{ ...decided.callers[0]!, covered: 'да' as const }, decided.callers[1]!] };
  assert.match(guidedPlanCallersProblem(wrongScope, callerFacts) ?? '', /covered «да», но файл не входит в files_to_touch/u);
  const wrongScopeBack = { ...decided, callers: [decided.callers[0]!, { ...decided.callers[1]!, covered: 'нет' as const }] };
  assert.match(guidedPlanCallersProblem(wrongScopeBack, callerFacts) ?? '', /covered «нет», но файл уже в files_to_touch/u);
  assert.equal(guidedPlanCallersProblem({ ...plan, steps: [{ ...step, contract: 'н/п — сигнатура не меняется' }] }, callerFacts), null,
    'шаг без изменения контракта не требует решений');
  assert.equal(guidedPlanCallersProblem({ ...plan, steps: [{ ...step, symbol: 'новый: billV2' }] }, callerFacts), null,
    'новый символ не имеет вызывающих в индексе');
});

test('a named export with a generic add-export action identifies the literal symbol', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'a.ts'), 'export const other = 1;');
  const plan = { approach: 'source', steps: [{ id: 1, file: 'a.ts', isNew: false, symbol: 'export validateCustomer',
    action: 'добавить экспорт', claims: ['claim-1'], check: 'import', expected: 'works', contract: 'add', dependsOn: [] }],
    excluded: [], axes: [], changes: 'none', callers: [] };
  assert.equal(assignGuidedPlanFileState(plan, root).steps[0]?.symbol, 'новый: validateCustomer');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...plan.steps[0]!, symbol: 'export' }] }, root).steps[0]?.symbol, 'other');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...plan.steps[0]!, symbol: 're-export' }] }, root).steps[0]?.symbol, 'other');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...plan.steps[0]!, symbol: 'exports' }] }, root).steps[0]?.symbol, 'other');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...plan.steps[0]!, symbol: 'exports', action: 'unrelated action' }] }, root).steps[0]?.symbol, 'exports');
  writeFileSync(join(root, 'a.ts'), 'export { oldFeature } from "./old.ts";');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...plan.steps[0]!, symbol: 'exports' }] }, root).steps[0]?.symbol, 'oldFeature');
});
test('mandatory implementation paths do not promote read-only exploration dependencies', t => {
  const { root } = fixture(t);
  const paths = guidedRequiredImplementationPaths('## Что делаем\nСоздать src/new.ts на основе анализа src/dependency.ts.\n', ['Re-export newRule from src/index.ts.'], root);
  assert.deepEqual(paths,['src/new.ts','src/index.ts']);
});

test('star re-export resolves only a uniquely planned new source declaration', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/index.ts'), 'export const old = 1;');
  const step = { id: 1, file: 'src/index.ts', isNew: false, symbol: "export * from './validate'",
    action: 'добавить экспорт', claims: ['claim-1'], check: 'import', expected: 'works', contract: 'add', dependsOn: [] };
  const owner = { ...step, id: 2, file: 'src/validate.ts', symbol: 'export function validateCustomer' };
  const plan = { approach: 'source', steps: [step, owner], excluded: [], axes: [], changes: 'none', callers: [] };
  assert.equal(assignGuidedPlanFileState(plan, root).steps[0]?.symbol, 'новый: validateCustomer');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [step] }, root).steps[0]?.symbol, step.symbol);
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [...plan.steps, { ...owner, id: 3 }] }, root).steps[0]?.symbol, step.symbol);
  writeFileSync(join(root, owner.file), 'export function validateCustomer() {}');
  assert.equal(assignGuidedPlanFileState(plan, root).steps[0]?.symbol, step.symbol);
});

test('invalid TypeScript proposals are rejected before approval or file writes', t => {
  const { root } = fixture(t);
  assert.throws(() => simulateOps(root, ['a.ts'], [{ op: 'create_file', file: 'a.ts',
    body: 'export function validate(x): string[] => { return []; }' }]), /Синтаксис черновика/);
  assert.equal(existsSync(join(root, 'a.ts')), false);
  assert.equal(simulateOps(root, ['a.ts'], [{ op: 'create_file', file: 'a.ts',
    body: 'export enum Codes { email, phone }' }]).length, 1);
});

test('whole-file rewrite requires ownership of the exact newly created bytes', t => {
  const { root } = fixture(t);
  const path = join(root, 'a.ts');
  const before = 'export const n = 1;';
  writeFileSync(path, before);
  const create = [{ op: 'create_file' as const, file: 'a.ts', body: 'export const n = 2;' }];
  assert.throws(() => simulateOps(root, ['a.ts'], create), /уже существует/);
  assert.throws(() => simulateOps(root, ['a.ts'], create, [{ path, before: 'old', after: before }]), /уже существует/);
  assert.throws(() => simulateOps(root, ['a.ts'], create, [{ path, before: null, after: 'external mismatch' }]), /уже существует/);
  assert.equal(simulateOps(root, ['a.ts'], create, [{ path, before: null, after: before }])[0]?.after, 'export const n = 2;\n');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('red Verify reopens a checked group for an actual model proposal', async t => {
  const { root, paths } = fixture(t);
  const options = { paths, items: [item(['a.ts'])], inputRevision: () => 'revision',
    requirements: 'add n', sources: '', contextWindow: 16000, check: async () => ({ passed: true, environment: false, result: 'tests pass' }) };
  const first = new GuidedExecutor({ ...options, provider: provider([{ action: 'patch', prediction: 'pass',
    ops: [{ op: 'create_file', file: 'a.ts', body: 'export const n = 1;' }] }]) });
  assert.equal((await first.run(request(root), hooks())).ok, true);
  const retry = new GuidedExecutor({ ...options, retryFeedback: 'n must be 2', provider: provider([{ action: 'patch', prediction: 'n is 2',
    ops: [{ op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 2;' }] }]) });
  const result = await retry.run(request(root), hooks());
  assert.equal(result.ok, true);
  assert.equal(result.modelRequests, 1);
  assert.ok(readFileSync(join(root, 'a.ts'), 'utf8').includes('n = 2'));
  assert.equal(readGuided(paths)?.items[0]?.attempts, 2);
});

test('anchored repair drafts only named files and rechecks unaffected groups', async t => {
  const { root, paths } = fixture(t);
  let checks = 0;
  const options = { paths, items: [item(['a.ts', 'b.ts']), { ...item(['c.ts']), id: 'work-2' }], inputRevision: () => 'revision',
    requirements: 'add values', sources: '', contextWindow: 16000, draftPerFile: true,
    check: async () => { checks++; return { passed: true, result: 'tests pass' }; } };
  const first = new GuidedExecutor({ ...options, provider: provider(['a.ts', 'b.ts', 'c.ts'].map(path => ({ action: 'patch', prediction: 'pass',
    ops: [{ op: 'create_file', file: path, body: 'export const n = 1;' }] }))) });
  assert.equal((await first.run(request(root), hooks())).ok, true);
  const before = readFileSync(join(root, 'a.ts'), 'utf8');
  const retry = new GuidedExecutor({ ...options, retryFeedback: 'a.ts n must be 2', retryFiles: ['a.ts'],
    provider: provider([{ action: 'patch', prediction: 'pass', ops: [{ op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 2;' }] }]) });
  const result = await retry.run(request(root), hooks());
  assert.equal(result.ok, true); assert.equal(result.modelRequests, 1); assert.equal(checks, 4);
  assert.equal(readFileSync(join(root, 'b.ts'), 'utf8'), before);
  assert.equal(readFileSync(join(root, 'c.ts'), 'utf8'), before);
});

test('unknown, unanchored or ambiguous repair evidence retains the full repair scope', () => {
  const finding = { section: 'review' as const, text: 'bug', evidence: 'a.ts:12', anchored: true };
  assert.deepEqual(guidedRetryFiles(['src/a.ts', 'src/b.ts'], [finding]), ['src/a.ts']);
  assert.deepEqual(guidedRetryFiles(['src/a.ts', 'src/b.ts'], [finding], ['src/b.ts']), ['src/b.ts', 'src/a.ts']);
  assert.equal(guidedRetryFiles(['src/a.ts', 'other/a.ts'], [finding]), undefined);
  assert.equal(guidedRetryFiles(['src/a.ts'], [{ ...finding, anchored: false }]), undefined);
  assert.equal(guidedRetryFiles(['src/a.ts'], [{ ...finding, evidence: 'unknown.ts' }]), undefined);
});

test('dependency context carries only observed untouched code within a fixed budget', () => {
  const context = observedImplementationContext([
    { path: 'src/types.ts', kind: 'code', text: 'export type Warehouse = string;' },
    { path: 'src/new.ts', kind: 'code', text: 'WRITABLE' },
    { path: 'src/private.ts', kind: 'code', text: 'UNOBSERVED' },
    { path: 'test/a.test.ts', kind: 'test', text: 'TEST' },
  ], new Set(['src/types.ts', 'src/new.ts', 'test/a.test.ts']), ['src/new.ts']);
  assert.ok(context.includes('export type Warehouse'));
  assert.ok(!context.includes('WRITABLE')); assert.ok(!context.includes('UNOBSERVED')); assert.ok(!context.includes('TEST'));
});

test('empty proposals stop after three cycles without consuming the full model budget', async t => {
  const { root, paths } = fixture(t); writeFileSync(join(root, 'a.ts'), 'export const n = 1;');
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])],
    provider: provider([{ action: 'patch', prediction: 'pass', ops: [{ op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 1;' }] }]),
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16000, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, false); assert.match(result.note!, /Три предложения/); assert.equal(result.modelRequests, 3);
});

test('a failed check remains visible in every subsequent per-file draft', async t => {
  const { root, paths } = fixture(t); let requests = 0; let checks = 0;
  const model = provider([]);
  model.chat = async input => {
    const q = JSON.parse(input.messages[1]!.content as string);
    if (requests >= 2) assert.equal(q.failedCheck, 'IMPORT_TYPE_ERROR');
    const path = q.files[0].path; const current = q.files[0].content;
    requests++;
    return { text: JSON.stringify({ action: 'patch', prediction: 'pass', ops: [current === null
      ? { op: 'create_file', file: path, body: 'export const n = 1;' }
      : { op: 'replace_body', file: path, symbol: 'n', body: 'export const n = 2;' }] }), toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts', 'b.ts'])], draftPerFile: true, provider: model,
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16000,
    check: async () => ({ passed: ++checks > 1, result: checks === 1 ? 'IMPORT_TYPE_ERROR' : 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, true); assert.equal(requests, 4);
});

test('native read alias translates a strict range without granting arbitrary tools', () => {
  const call = { id: '1', name: 'repo_browser.open_file', arguments: { path: 'src/index.ts', line_start: 3, line_end: 400 }, rawArguments: '' };
  assert.deepEqual(parseGuidedTurn({ text: '', toolCalls: [call] }), { action: 'read', path: 'src/index.ts', offset: 3, limit: 120 });
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [{ ...call, arguments: { ...call.arguments, command: 'unsafe' } }] }));
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [{ ...call, arguments: { ...call.arguments, line_end: 2 } }] }));
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [{ ...call, name: 'arbitrary.open_file' }] }));
});
test('rejected new-file code remains visible after a read and is never written before repair', async t => {
  const {root,paths} = fixture(t); writeFileSync(join(root,'helper.ts'),'export const x = 1;');
  const bad = 'export function check() { await Promise.resolve(); }';
  let calls=0;
  const model = {name:'rejected-draft-spy',async chat(req:any) {
    calls++; const data = JSON.parse(req.messages[1].content);
    if (calls > 1) { assert.equal(existsSync(join(root,'a.ts')),false); assert.equal(data.rejectedProposal.ops[0].body,bad); assert.match(data.rejectedProposal.error,/await/); }
    const answer = calls === 1 ? {action:'patch',prediction:'valid syntax',ops:[{op:'create_file',file:'a.ts',body:bad}]} :
      calls === 2 ? {action:'read',path:'helper.ts',offset:1,limit:120} :
      {action:'patch',prediction:'callback async',ops:[{op:'create_file',file:'a.ts',body:'export async function check() { await Promise.resolve(); }'}]};
    return {text:JSON.stringify(answer),toolCalls:[],finishReason:'end_turn',usage:emptyUsage()};
  }} as unknown as ChatProvider;
  const result = await new GuidedExecutor({paths,items:[item(['a.ts'])],provider:model,inputRevision:()=> 'r',requirements:'',sources:'',contextWindow:16000,
    check:async()=>({passed:true,result:'pass'})}).run(request(root),hooks());
  assert.equal(result.ok,true,result.note); assert.equal(calls,3); assert.match(readFileSync(join(root,'a.ts'),'utf8'),/async/);
});

test('empty truncation keeps reasoning effort and raises the token cap instead', async t => {
  const { root, paths } = fixture(t); const seen: Array<{ effort: unknown, max: number }> = [];
  const model = { name:'reasoning-spy', async chat(req: any) {
    seen.push({ effort: req.params.reasoning_effort, max: req.params.max_tokens });
    return {text:seen.length === 1 ? '' : JSON.stringify({action:'no_change',reason:'no changes required'}),toolCalls:[],
      finishReason:seen.length === 1 ? 'max_tokens' : 'end_turn',usage:emptyUsage()};
  }} as unknown as ChatProvider;
  const result = await new GuidedExecutor({paths,items:[item(['a.ts'])],provider:model,params:{reasoning_effort:'medium'},inputRevision:()=> 'r',
    requirements:'preserve',sources:'',contextWindow:16000,check:async()=>({passed:true,result:'pass'})}).run(request(root),hooks());
  assert.equal(result.ok,true,result.note);
  assert.deepEqual(seen.map(s => s.effort),['medium','medium']);
  assert.ok(seen[1]!.max > seen[0]!.max); assert.equal(result.modelRequests,2);
});

test('native transport arguments use the same guided schema without granting tools', () => {
  const call = { id: '1', name: 'assistant', arguments: { action: 'read', path: 'src/index.ts', offset: 1, limit: 200 }, rawArguments: '' };
  assert.deepEqual(parseGuidedTurn({ text: '', toolCalls: [call] }), { action: 'read', path: 'src/index.ts', offset: 1, limit: 120 });
  assert.throws(() => parseGuidedTurn({ text: '{}', toolCalls: [call] }));
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [call, call] }));
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [{ ...call, name: 'Bash', arguments: { command: 'echo unsafe' } }] }));
  assert.throws(() => parseGuidedTurn({ text: '', toolCalls: [{ ...call, arguments: { ...call.arguments, command: 'echo unsafe' } }] }));
});

test('runtime journal records only current checked evidence and preserves human fields', async t => {
  const { root, paths } = fixture(t);
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], provider: provider([{ action: 'patch', prediction: 'n exported',
    ops: [{ op: 'create_file', file: 'a.ts', body: 'export const n = 1;' }] }]),
    inputRevision: () => guidedInputRevision(paths), requirements: '', sources: '', contextWindow: 16384,
    check: async () => ({ passed: true, result: 'actual check output' }) }).run(request(root), hooks());
  assert.equal(result.ok, true);
  const before = '# Журнал\n- **Подтвердил:** оператор · 2026-10-04\n';
  const recorded = appendGuidedJournalFacts(paths, before);
  assert.ok(recorded.startsWith(before)); assert.match(recorded, /actual check output/); assert.match(recorded, /n exported/);
  assert.equal(appendGuidedJournalFacts(paths, recorded), recorded);
  assert.ok(guidedReviewContext(paths).includes('export const n = 1;'));
  writeFileSync(join(root, 'a.ts'), 'changed externally');
  assert.equal(guidedReviewContext(paths), '');
  assert.equal(appendGuidedJournalFacts(paths, before), before);
});

test('approved source evidence survives checked implementation but rejects subsequent external edits', async t => {
  const { root, paths } = fixture(t);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'));
  const original = 'export const n = 1;\n// retained\n';
  writeFileSync(join(root, 'src/a.ts'), original); writeFileSync(join(root, 'src/source.ts'), 'export const source = 1;');
  initializePreparation(paths, 'Update src/a.ts; create test/New.test.ts.');
  recordPreparationRead(paths, 'explore', 'src/a.ts', original);
  recordPreparationRead(paths, 'explore', 'src/source.ts', 'export const source = 1;');
  writeArtifact(paths.intent, '# Задача\nОбновить n.');
  const plan = '## Подход\nИзменить src/a.ts, добавить test/New.test.ts; основание src/source.ts.\n## Шаги\n### Шаг 1 — изменить n\n- файл: src/a.ts (существующий)\n### Шаг 2 — тест\n- файл: test/New.test.ts (новый)\n## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| src/a.ts | изменить |\n| test/New.test.ts | создать |\n\n- **Одобрение:** оператор · 2026-10-04\n';
  writeArtifact(paths.plan, plan);
  assert.equal(preparationPlanEvidenceProblem(paths, plan), null);
  const state = preparation(paths)!;
  state.revisions.push({ revision: 1, requestsHash: sourceHash(JSON.stringify(state.requests)),
    requirementsHash: resolvedRequirementsHash(readFileSync(paths.intent, 'utf8'), ''), planHash: planContentHash(plan),
    intent: readFileSync(paths.intent, 'utf8'), plan, clarifications: '', approvedBy: 'оператор', approvedAt: '2026-10-04' });
  savePreparation(paths, state);
  const result = await new GuidedExecutor({ paths, items: [item(['src/a.ts', 'test/New.test.ts'])], provider: provider([{ action: 'patch', prediction: 'pass', ops: [
    { op: 'replace_body', file: 'src/a.ts', symbol: 'n', body: 'export const n = 2;' },
    { op: 'create_file', file: 'test/New.test.ts', body: 'export const tested = true;' }], }]),
    inputRevision: () => guidedInputRevision(paths), requirements: '', sources: '', contextWindow: 16384,
    check: async () => ({ passed: true, result: 'actual check' }) }).run(request(root), hooks());
  assert.equal(result.ok, true);
  assert.ok(preparationPlanEvidenceProblem(paths, plan));
  const hashes = guidedImplementationHashes(paths)!; assert.ok(hashes);
  recordPreparationImplementation(paths, hashes);
  assert.ok(preparation(paths)?.checkedImplementation);
  assert.equal(preparationPlanEvidenceProblem(paths, plan), null);
  writeFileSync(join(root, 'src/source.ts'), 'external edit');
  assert.match(preparationPlanEvidenceProblem(paths, plan)!, /src\/source.ts/);
  writeFileSync(join(root, 'src/source.ts'), 'export const source = 1;');
  writeFileSync(join(root, 'test/New.test.ts'), 'external edit');
  assert.match(preparationPlanEvidenceProblem(paths, plan)!, /изменилась после проверки/);
  assert.equal(guidedImplementationHashes(paths), null);
  writeFileSync(join(root, 'test/New.test.ts'), 'export const tested = true;');
  writeFileSync(join(root, 'src/a.ts'), 'external edit');
  assert.match(preparationPlanEvidenceProblem(paths, plan)!, /изменилась после проверки/);
});

test('native-carried reads go through the existing gate before a patch', async t => {
  const { root, paths } = fixture(t); writeFileSync(join(root, 'source.ts'), 'export const source = 1;');
  let calls = 0; let reads = 0; const model = provider([]);
  model.chat = async input => {
    if (calls++ === 0) return { text: '', toolCalls: [{ id: '1', name: 'assistant', arguments: { action: 'read', path: 'source.ts', offset: 1, limit: 200 }, rawArguments: '' }],
      finishReason: 'tool_use', usage: emptyUsage() };
    assert.match(JSON.parse(input.messages[1]!.content as string).feedback, /export const source/);
    return { text: JSON.stringify({ action: 'patch', prediction: 'pass', ops: [{ op: 'create_file', file: 'a.ts', body: 'export const a = 1;' }] }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  };
  const h = hooks(); h.onToolRequest = async call => { if (call.kind === 'read') reads++; return { allowed: true, updatedInput: null, by: 'policy' }; };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], provider: model, inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16384, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), h);
  assert.equal(result.ok, true); assert.equal(reads, 1);
});

test('invalid op proposals do not consume behavioral check attempts', async t => {
  const { root, paths } = fixture(t);
  const model = provider([{ action: 'patch', prediction: 'pass', ops: [{ op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'x' }] },
    { action: 'patch', prediction: 'pass', ops: [{ op: 'create_file', file: 'a.ts', body: 'export const n = 1;' }] }]);
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], provider: model, inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16384, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, true);
  assert.equal(readGuided(paths)?.items[0]?.attempts, 1);
});

test('valid drafts reset consecutive proposal failures for the next file', async t => {
  const { root, paths } = fixture(t);
  const bad = (path: string) => ({ action: 'patch', prediction: 'pass', ops: [{ op: 'replace_body', file: path, symbol: 'n', body: 'x' }] });
  const good = (path: string) => ({ action: 'patch', prediction: 'pass', ops: [{ op: 'create_file', file: path, body: 'export const n = 1;' }] });
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts', 'b.ts'])], draftPerFile: true,
    provider: provider([bad('a.ts'), bad('a.ts'), good('a.ts'), bad('b.ts'), good('b.ts')]), inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16384, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, true);
  assert.equal(readGuided(paths)?.items[0]?.attempts, 1);
});

test('format repair requests a fresh compact proposal without echoing a truncated answer', async t => {
  const { root, paths } = fixture(t); let calls = 0;
  const model = provider([]);
  model.chat = async input => {
    if (calls++ === 0) return { text: '{"action":"patch","BROKEN_PAYLOAD":', toolCalls: [], finishReason: 'max_tokens', usage: emptyUsage() };
    const prompt = JSON.parse(input.messages[1]!.content as string);
    assert.equal(prompt.feedback.includes('BROKEN_PAYLOAD'), false);
    assert.match(prompt.feedback, /JSON/);
    return { text: JSON.stringify({ action: 'patch', prediction: 'pass', ops: [{ op: 'create_file', file: 'a.ts', body: 'export const n = 1;' }] }),
      toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
  };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], provider: model, inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16384, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, true);
});

test('question schema couples source names with bounded line-range citations', () => {
  const source = '1. Use `value` as-is.\n   Keep punctuation.\n\nSecond paragraph.';
  const format = guidedAskResponseFormat({ 'request-1': source }) as any;
  const branches = format.json_schema.schema.anyOf.filter((v: any) => v.properties.kind.enum[0] === 'source');
  assert.equal(branches.length, 1);
  assert.equal(branches[0].properties.source.const, 'request-1');
  const lines = branches[0].properties.lines;
  assert.deepEqual([lines.minItems, lines.maxItems], [2, 2]);
  assert.equal(lines.items.maximum, source.split('\n').length);
  assert.equal(branches[0].properties.quote, undefined);
});

test('group is approved in full before any mutation and check sees all files', async t => {
  const { root, paths } = fixture(t);
  const ops = ['a.ts', 'b.ts'].map(path => ({ op: 'create_file', file: path, body: 'export const n = 1;\n' }));
  const h = hooks(); let approvals = 0; const ids = new Set<string>();
  h.onToolRequest = async (_call, meta) => {
    assert.equal(existsSync(join(root, 'a.ts')), false);
    approvals++; ids.add(meta.requestId);
    return { allowed: true, updatedInput: null, by: 'policy' };
  };
  h.onToolResult = meta => { assert.ok(ids.has(meta.requestId)); };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts', 'b.ts'])], provider: provider([{ action: 'patch', prediction: 'both exported', ops }]),
    inputRevision: () => 'r1', requirements: 'add n', sources: '', contextWindow: 16384,
    check: async () => ({ passed: existsSync(join(root, 'a.ts')) && existsSync(join(root, 'b.ts')), result: 'two modules present' }) }).run(request(root), h);
  assert.equal(result.ok, true); assert.equal(approvals, 2);
  assert.equal(readGuided(paths)?.items[0]?.status, 'checked');
});

test('per-file drafts remain unwritten until the whole group is approved', async t => {
  const { root, paths } = fixture(t);
  const files = ['a.ts', 'b.ts']; let calls = 0; let approvals = 0; let checks = 0;
  const model = provider([]);
  model.chat = async input => {
    const prompt = JSON.parse(input.messages[1]!.content as string);
    assert.equal(prompt.files.length, 1);
    assert.equal(prompt.files[0].path, files[calls]);
    assert.deepEqual(prompt.item.files, [files[calls]]);
    assert.equal(prompt.item.title, calls === 0 ? 'implement A' : 'export B');
    assert.equal(files.some(file => existsSync(join(root, file))), false);
    const path = files[calls++]!;
    return { text: JSON.stringify({ action: 'patch', prediction: 'exports n', ops: [{ op: 'create_file', file: path, body: 'export const n = 1;' }] }),
      toolCalls: [], usage: emptyUsage(), finishReason: 'end_turn' };
  };
  const h = hooks();
  h.onToolRequest = async () => { approvals++; assert.equal(files.some(file => existsSync(join(root, file))), false);
    return { allowed: true, updatedInput: null, by: 'policy' }; };
  const result = await new GuidedExecutor({ paths, items: [item(files)], provider: model, draftPerFile: true,
    fileTasks: [{ file: 'a.ts', title: 'implement A', action: 'implement A', claims: ['claim-1'], expect: 'A ready', check: null, contractChange: 'A' },
      { file: 'b.ts', title: 'export B', action: 'export B', claims: ['claim-1'], expect: 'B ready', check: null, contractChange: 'B' }],
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => { checks++; assert.equal(files.every(file => existsSync(join(root, file))), true); return { passed: true, result: 'both exported' }; },
  }).run(request(root), h);
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(approvals, 2); assert.equal(checks, 1);
  assert.equal(readGuided(paths)?.items[0]?.attempts, 1);
});

test('a failed acceptance check routes the next draft to its named repair file', async t => {
  const { root, paths } = fixture(t); const files = ['src/validate.ts', 'test/validate.test.ts']; let calls = 0; let checks = 0;
  const model = provider([]);
  model.chat = async input => {
    const prompt = JSON.parse(input.messages[1]!.content as string);
    if (calls >= 2) assert.deepEqual(prompt.item.files, ['test/validate.test.ts']);
    const path = calls === 0 ? files[0]! : files[1]!; calls++;
    return { text: JSON.stringify({ action: 'patch', prediction: 'covered', ops: [prompt.files[0].content === null
      ? { op: 'create_file', file: path, body: 'export const validate = () => [];\n' }
      : { op: 'replace_body', file: path, symbol: 'validate', body: 'export const validate = () => ["case"];' }] }), toolCalls: [], usage: emptyUsage(), finishReason: 'end_turn' };
  };
  const result = await new GuidedExecutor({ paths, items: [item(files)], provider: model, draftPerFile: true,
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => ++checks === 1 ? { passed: false, result: 'positive 8 case missing', repairFiles: [files[1]!] }
      : { passed: true, result: 'pass' },
  }).run(request(root), hooks());
  assert.equal(result.ok, true, result.note); assert.equal(calls, 3); assert.equal(checks, 2);
});

test('denied draft group and a no-change final draft preserve atomic application', async t => {
  const { root, paths } = fixture(t); let approvals = 0;
  const proposals = ['a.ts', 'b.ts'].map(path => ({ action: 'patch', prediction: 'exports n', ops: [{ op: 'create_file', file: path, body: 'export const n = 1;' }] }));
  const options = { paths, items: [item(['a.ts', 'b.ts'])], draftPerFile: true, inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16384, check: async () => ({ passed: true, result: 'pass' }) };
  const h = hooks(); h.onToolRequest = async () => ++approvals === 2 ? { allowed: false, reason: 'denied', by: 'policy' }
    : { allowed: true, updatedInput: null, by: 'policy' };
  assert.equal((await new GuidedExecutor({ ...options, provider: provider(proposals) }).run(request(root), h)).ok, false);
  assert.equal(existsSync(join(root, 'a.ts')), false); assert.equal(existsSync(join(root, 'b.ts')), false);
  writeFileSync(join(root, 'b.ts'), 'already present');
  const resumed = await new GuidedExecutor({ ...options, provider: provider([proposals[0], { action: 'no_change', reason: 'b already exists' }]) }).run(request(root), hooks());
  assert.equal(resumed.ok, true); assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const n = 1;\n');
  assert.equal(readFileSync(join(root, 'b.ts'), 'utf8'), 'already present');
});

test('denial of second file leaves first file untouched', async t => {
  const { root, paths } = fixture(t); let count = 0;
  const h = hooks(); h.onToolRequest = async () => ++count === 1
    ? { allowed: true, updatedInput: null, by: 'policy' }
    : { allowed: false, reason: 'denied', by: 'policy' };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts', 'b.ts'])],
    provider: provider([{ action: 'patch', prediction: 'pass', ops: ['a.ts', 'b.ts'].map(path => ({ op: 'create_file', file: path, body: 'export const n = 1;' })) }]),
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => { throw new Error('must not run'); } }).run(request(root), h);
  assert.equal(result.ok, false); assert.equal(existsSync(join(root, 'a.ts')), false);
});

test('failed checks roll back only own changes and block downstream items', async t => {
  const { root, paths } = fixture(t);
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts']), { ...item(['b.ts']), id: 'work-2' }],
    provider: provider([{ action: 'patch', prediction: 'pass', ops: [{ op: 'create_file', file: 'a.ts', body: 'export const wrong = 1;' }] },
      { action: 'no_change', reason: 'already done' }]), inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => ({ passed: false, result: 'behavior mismatch' }) }).run(request(root), hooks());
  assert.equal(result.ok, false); assert.equal(existsSync(join(root, 'a.ts')), false);
  assert.equal(readGuided(paths)?.items[1]?.status, 'blocked');
  assert.equal(readGuided(paths)?.items[0]?.attempts, 3);
});

test('recovery preserves external edits and retains its durable transaction', t => {
  const { root, paths } = fixture(t); const path = join(root, 'a.ts');
  writeFileSync(path, 'external');
  const state = readGuided(paths)!;
  state.transaction = { itemId: 'work-1', files: [{ path, before: 'before', after: 'ours' }] };
  saveGuided(paths, state);
  assert.throws(() => restoreTransaction(root, state.transaction!.files), /Конфликт/);
  assert.equal(readFileSync(path, 'utf8'), 'external');
  assert.ok(readGuided(paths)?.transaction);
});

test('no-change still runs checks and unavailable environment never passes', async t => {
  const { root, paths } = fixture(t); let checks = 0;
  const result = await new GuidedExecutor({ paths, items: [item([])], provider: provider([{ action: 'no_change', reason: 'existing code' }]),
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => { checks++; return { passed: false, environment: true, result: 'test runner missing' }; } }).run(request(root), hooks());
  assert.equal(result.ok, false); assert.equal(checks, 1);
});

test('schema rejects additional fields and never treats prose as executable commands', () => {
  assert.throws(() => parseGuidedReply('run npm test'));
  assert.throws(() => parseGuidedReply('{"action":"no_change","reason":"done","command":"rm"}'));
  assert.equal(parseGuidedReply('{"action":"no_change","reason":"done"}.').action, 'no_change');
  assert.throws(() => parseGuidedReply('{"action":"no_change","reason":"done"}{}'));
  assert.throws(() => parseGuidedReply('{"action":"no_change","reason":"done"} run commands'));
});

test('dependency groups reject cycles and prevent detached contract changes', () => {
  const step = (n: number, dependsOn: number[]): PlanStep => ({ n, file: `${n}.ts`, title: 'change', action: 'change',
    dependsOn, claims: ['claim-1'], checkSpecified: true, explicit: true } as PlanStep);
  assert.equal(workItems([step(1, []), step(2, [1])], ['1.ts', '2.ts']).length, 1);
  assert.equal(workItems([step(1, []), step(2, [])], ['1.ts', '2.ts']).length, 1, 'shared requirement is an actual dependency');
  assert.equal(workItems([step(1, []), { ...step(2, []), claims: ['claim-2'] }], ['1.ts', '2.ts']).length, 2);
  const bridge = {...step(3, []), claims:['claim-1','claim-2']};
  assert.equal(workItems([step(1, []), { ...step(2, []), claims:['claim-2'] },bridge], ['1.ts','2.ts','3.ts']).length, 1, 'tests bridge implementation and export');
  assert.throws(() => workItems([step(1, [2]), step(2, [1])], ['1.ts', '2.ts']), /Цикл/);
  assert.throws(() => workItems([step(1, [8])], ['1.ts']), /зависимость/);
});

test('repair crash recovers intermediate version without losing original bytes', t => {
  const { root } = fixture(t); const path = join(root, 'a.ts');
  writeFileSync(path, 'first repair');
  restoreTransaction(root, [{ path, before: 'original', after: 'second repair', previous: ['first repair'] }]);
  assert.equal(readFileSync(path, 'utf8'), 'original');
});

test('repartition performs all parts before checking the group', async t => {
  const { root, paths } = fixture(t); let checks = 0;
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts', 'b.ts'])],
    provider: provider([
      ...Array.from({ length: 3 }, () => ({ action: 'no_change', reason: 'hypothesis' })),
      { action: 'split', parts: ['a.ts', 'b.ts'].map(path => ({ title: path, files: [path], prediction: 'export exists' })) },
      ...['a.ts', 'b.ts'].map(path => ({ action: 'patch', prediction: 'export exists', ops: [{ op: 'create_file', file: path, body: 'export const value = 1;' }] })),
    ]), inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    check: async () => { checks++; return { passed: existsSync(join(root, 'a.ts')) && existsSync(join(root, 'b.ts')), result: 'both files required' }; },
  }).run(request(root), hooks());
  assert.equal(result.ok, true); assert.equal(checks, 4);
  assert.equal(readGuided(paths)?.items[0]?.attempts, 4);
});

test('checked resume rejects a change during checking', async t => {
  const { root, paths } = fixture(t); const path = join(root, 'a.ts');
  writeFileSync(path, 'export const value = 1;\n// end');
  const options = { paths, items: [item(['a.ts'])], writableFiles: [], inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    provider: provider([{ action: 'no_change', reason: 'already works' }]), check: async () => ({ passed: true, result: 'checked' }) };
  assert.equal((await new GuidedExecutor(options).run(request(root), hooks())).ok, true);
  const resumed = await new GuidedExecutor({ ...options, check: async () => {
    writeFileSync(path, 'external'); return { passed: true, result: 'old check' };
  } }).run(request(root), hooks());
  assert.equal(resumed.ok, false); assert.equal(readFileSync(path, 'utf8'), 'external');
});

test('guided plan renders coherent steps and leaves human approval blank', () => {
  const value = { approach: 'Use the existing calculation', steps: [{ id: 1, file: 'src/price.ts', isNew: false, symbol: 'priceFor',
    action: 'apply threshold', claims: ['claim-1'], check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] }],
    excluded: ['old tests'], axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'invariant' })), changes: 'none', callers: [] };
  const claims = [{ id: 'claim-1', behavior: 'threshold', procedure: 'test', expected: 'pass' }];
  const rendered = renderGuidedPlan(value, 'price', claims);
  assert.equal(extractExplicitSteps(rendered)[0]?.file, 'src/price.ts');
  assert.ok(rendered.includes('‹имя и дата›'));
  assert.ok(!rendered.includes('moveHold'));
  assert.throws(() => renderGuidedPlan(value, 'price', [{ ...claims[0]!, id: 'claim-2' }]), /claim/);
  assert.ok(renderGuidedPlan({ ...value, steps: [] }, 'price', claims).includes('guided:no-change'));
});

test('guided plan and research request strict JSON schemas for compatible providers', () => {
  const plan = guidedPlanResponseFormat() as { type: string; json_schema: { strict: boolean; schema: { required: string[]; properties: Record<string, unknown> } } };
  assert.equal(plan.type, 'json_schema'); assert.equal(plan.json_schema.strict, true);
  assert.deepEqual(plan.json_schema.schema.required, ['approach', 'steps', 'excluded', 'axes', 'changes', 'callers']);
  assert.equal((plan.json_schema.schema.properties.steps as { type: string }).type, 'array');
  const research = guidedFileResearchResponseFormat() as { type: string; json_schema: { strict: boolean; schema: { required: string[] } } };
  assert.equal(research.type, 'json_schema'); assert.equal(research.json_schema.strict, true);
  assert.deepEqual(research.json_schema.schema.required, ['fact', 'impact', 'change', 'reuse', 'risks', 'questions']);
  const ask = guidedAskResponseFormat() as { type: string; json_schema: { strict: boolean; schema: { anyOf: unknown[] } } };
  assert.equal(ask.type, 'json_schema'); assert.equal(ask.json_schema.strict, true);
  assert.equal(ask.json_schema.schema.anyOf.length, 4);
});

test('guided Ask discards only an exact placeholder question', () => {
  assert.equal(isPlaceholderGuidedQuestion('вопрос'), true);
  assert.equal(isPlaceholderGuidedQuestion('Question 2?'), true);
  assert.equal(isPlaceholderGuidedQuestion('Какие правила валидации применить?'), false);
  assert.equal(isPlaceholderGuidedQuestion('Неизвестно, какую политику выбрать?'), false);
});

test('guided JSON accepts trailing commas outside strings while preserving string contents', () => {
  assert.deepEqual(parseGuidedJson('```json\n{"note":"literal , } stays", "items":[1,2,],}\n```'),
    { note: 'literal , } stays', items: [1, 2] });
  assert.deepEqual(parseGuidedJson(['{"fact":"line one', 'line two", "risks":[],}'].join('\n')),
    { fact: 'line one\nline two', risks: [] });
  assert.throws(() => parseGuidedJson('{"value":'), SyntaxError);
});

test('guided JSON strips Markdown bold only around property keys', () => {
  assert.deepEqual(parseGuidedJson('{"fact":{**"interface"**:true,**"name"**:"**keep this value**"}}'),
    { fact: { interface: true, name: '**keep this value**' } });
});

test('guided JSON escapes unquoted quotes embedded inside a prose value', () => {
  assert.deepEqual(parseGuidedJson('{"fact":"ReserveResult = {ok: true} is returned"}'),
    { fact: 'ReserveResult = {ok: true} is returned' });
});

test('guided JSON drops one unmatched array-closing delimiter after an object', () => {
  assert.deepEqual(parseGuidedJson('{"fact":"ok","questions":[]} ]'),
    { fact: 'ok', questions: [] });
  assert.throws(() => parseGuidedJson('{"fact":"ok"}] trailing text'), SyntaxError);
});

test('guided JSON parses an uninterrupted comma-separated sequence of complete objects', () => {
  assert.deepEqual(parseGuidedJson('{"fact":"template"},{"fact":"evidence"}'),
    [{ fact: 'template' }, { fact: 'evidence' }]);
  assert.throws(() => parseGuidedJson('{"fact":"one"}, trailing text'), SyntaxError);
});

test('guided plans retain the fingerprint of their current requirement inputs', () => {
  const intent = '# task\nclaim-1'; const clarifications = 'no open questions';
  const plan = addRequirementsHash('## Подход\nUse the inspected source.', resolvedRequirementsHash(intent, clarifications));
  assert.equal(readRequirementsHash(plan), resolvedRequirementsHash(intent, clarifications));
});

test('guided plan dependencies accept canonical integers and exact model encodings', () => {
  const base = { approach: 'Implement from inspected evidence', steps: [{ id: 1, file: 'src/a.ts', isNew: false, symbol: 'runA',
    action: 'Prepare dependency', claims: ['claim-1'], check: 'test', expected: 'pass', contract: 'same', dependsOn: [] },
    { id: 2, file: 'src/b.ts', isNew: false, symbol: 'run',
    action: 'Implement behavior', claims: ['claim-1'], check: 'test', expected: 'pass', contract: 'same', dependsOn: [] }],
    excluded: [], axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'invariant' })), changes: 'none' };
  for (const [encoded, expected] of [[1, [1]], ['step 1', [1]], [{ step: 1 }, [1]], ['src/a.ts', [1]]] as const) {
    assert.deepEqual(parseGuidedPlan({ ...base, steps: [base.steps[0], { ...base.steps[1], dependsOn: encoded }] }).steps[1]?.dependsOn, expected);
  }
  assert.deepEqual(parseGuidedPlan({ ...base, steps: [base.steps[0], { ...base.steps[1], dependsOn: 'none' }] }).steps[1]?.dependsOn, []);
  assert.throws(() => parseGuidedPlan({ ...base, steps: [base.steps[0], { ...base.steps[1], dependsOn: [{ step: 'first' }] }] }));
});

test('unchanged source evidence is available only for the checked revision', async t => {
  const { root, paths } = fixture(t); const path = join(root, 'a.ts');
  writeFileSync(path, 'export const value = 1;');
  assert.deepEqual(guidedSourceHunks(paths), []);
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], writableFiles: [],
    inputRevision: () => guidedInputRevision(paths), requirements: '', sources: '', contextWindow: 16384,
    provider: provider([{ action: 'no_change', reason: 'existing behavior' }]), check: async () => ({ passed: true, result: 'checked' }),
  }).run(request(root), hooks());
  assert.equal(result.ok, true); assert.equal(guidedSourceHunks(paths)[0]?.file, 'a.ts');
  writeFileSync(path, 'external change');
  assert.deepEqual(guidedSourceHunks(paths), []);
});

test('read-only work item rejects edits before asking approval', async t => {
  const { root, paths } = fixture(t); let approvals = 0;
  const h = hooks(); h.onToolRequest = async () => { approvals++; return { allowed: true, updatedInput: null, by: 'policy' }; };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], writableFiles: [],
    inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    provider: provider([{ action: 'patch', prediction: 'wrong', ops: [{ op: 'create_file', file: 'a.ts', body: 'bad' }] }]),
    check: async () => { throw new Error('must not check'); },
  }).run(request(root), h);
  assert.equal(result.ok, false); assert.equal(approvals, 0); assert.equal(existsSync(join(root, 'a.ts')), false);
});

test('cancellation during a check restores the group', async t => {
  const { root, paths } = fixture(t); const controller = new AbortController();
  const req = { ...request(root), signal: controller.signal };
  const result = await new GuidedExecutor({ paths, items: [item(['a.ts'])], inputRevision: () => 'r', requirements: '', sources: '', contextWindow: 16384,
    provider: provider([{ action: 'patch', prediction: 'export', ops: [{ op: 'create_file', file: 'a.ts', body: 'export {}' }] }]),
    check: async () => { controller.abort(); controller.signal.throwIfAborted(); return { passed: true, result: '' }; },
  }).run(req, hooks());
  assert.equal(result.ok, false); assert.equal(existsSync(join(root, 'a.ts')), false);
  assert.equal(readGuided(paths)?.transaction, undefined);
});

test('research schema retains four columns and rejects invented evidence', () => {
  const sources = new Map([['a.ts', 'export function calculate() { return 1; }']]);
  const research = { summary: 'Current behavior returns one', files: [{ path: 'a.ts', symbol: 'calculate', fact: 'returns 1', impact: 'source of result', change: null }],
    reuse: [{ path: 'a.ts', symbol: 'calculate', purpose: 'returns current value', use: 'keep public function' }], risks: [], questions: [] };
  const rendered = renderGuidedResearch(research, 'case', sources, ['claim-1: returns 1']);
  assert.ok(rendered.includes('| a.ts | calculate | returns 1 | source of result |'));
  assert.ok(rendered.includes('| a.ts | calculate | returns current value | keep public function |'));
  assert.ok(renderGuidedResearch({ ...research, files: [...research.files, { ...research.files[0]!, fact: 'public export' }] }, 'case', sources, []).includes('public export'));
  assert.ok(renderGuidedResearch({ ...research, files: [{ ...research.files[0]!, symbol: 'a.ts' }] }, 'case', sources, []).includes('a.ts'));
  assert.throws(() => renderGuidedResearch({ ...research, files: [{ ...research.files[0], path: 'missing.ts' }] }, 'case', sources, []), /не показан/);
  assert.throws(() => renderGuidedResearch({ ...research, files: [{ ...research.files[0], symbol: 'imagined' }] }, 'case', sources, []), /Символ/);
});

test('guided research records delivered sources and writes through the common gate', async t => {
  const { root, paths } = fixture(t); const evidence: string[] = [];
  const source = 'export const value = 1;';
  const response = '{"fact":"существующее поведение: назови важные функции из кода и их контракт","impact":"что это значит для задачи","change":null,"reuse":null,"risks":[],"questions":[]},' +
    '{"fact":"equals one","impact":"requirement","change":{"behavior":"preserve current contract"},"reuse":null,"risks":[],"questions":[]}';
  const modelProvider = { name: 'test', chat: async () => ({ text: response, toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() }) } as unknown as ChatProvider;
  const options = { provider: modelProvider, built: { ranked: [{ file: { path: 'a.ts', text: source } }] },
    intent: { path: paths.intent, title: 'case', claims: [] }, reportPath: paths.explorationReport,
    maxResultBytes: 10000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000,
    onSourceProvided: (path: string) => evidence.push(path) } as unknown as ExploreExecutorOptions;
  const result = await new GuidedExploreExecutor(options).run(request(root), hooks());
  assert.equal(result.ok, true); assert.equal(result.modelRequests, 1);
  assert.deepEqual(evidence, ['a.ts']);
  assert.ok(readFileSync(paths.explorationReport, 'utf8').includes('equals one'));
  assert.ok(readFileSync(paths.explorationReport, 'utf8').includes('{"behavior":"preserve current contract"}'));
});

test('guided research records the duration of a timed-out request and names it in warnings', async t => {
  // Разбор прогона 2026-10-05: два запроса разведки висели по ~300 с, и в метриках этапа
  // это было неотличимо от медленного, но состоявшегося ответа. Обрыв по таймауту
  // (`limits.exploreRequestTimeoutMs`) обязан оставить и замер длительности, и предупреждение.
  const { root, paths } = fixture(t);
  const durations: number[] = [];
  const warnings: string[] = [];
  const slow = { name: 'test', chat: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    throw new ProviderEnvError('ollama: ответ не получен за 120000 мс — таймаут запроса');
  } } as unknown as ChatProvider;
  const options = { provider: slow, built: { ranked: [{ file: { path: 'a.ts', text: 'export const value = 1;' } }] },
    intent: { path: paths.intent, title: 'case', claims: [] }, reportPath: paths.explorationReport,
    maxResultBytes: 10000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000 } as unknown as ExploreExecutorOptions;
  const h = hooks();
  h.onUsage = (_usage: unknown, durationMs?: number) => { if (durationMs !== undefined && durationMs > 0) durations.push(durationMs); };
  h.onWarn = (message: string) => { warnings.push(message); };
  await assert.rejects(() => new GuidedExploreExecutor(options).run(request(root), h), /таймаут запроса/);
  assert.equal(durations.length, 1, JSON.stringify(durations));
  assert.ok(warnings.some((w) => w.includes('a.ts') && w.includes('таймаут запроса')), warnings.join(' | '));
});

test('task clock excludes paused intervals and survives stale executor snapshots', t => {
  const { paths } = fixture(t);
  const stale = readGuided(paths)!;
  assert.equal(accountGuidedTime(paths, 1000, true), false);
  assert.equal(accountGuidedTime(paths, 3600000, false), false);
  saveGuided(paths, stale);
  assert.equal(readGuided(paths)?.activeMs, 1000);
  assert.equal(accountGuidedTime(paths, 1799000, true), true);
  assert.equal(readGuided(paths)?.remainingMs, 0);
  assert.ok(readGuided(paths)?.stopReason?.includes('30 минут'));
});

test('guided questions persist literal human facts and close only answered questions', async t => {
  const { root, paths } = fixture(t);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Порог?\n');
  writeArtifact(paths.explorationReport, '# Research\n## Вопросы человеку\n- [ ] [блокирующий] Порог?\n- [ ] [блокирующий] Валюта?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async call => {
    assert.equal(call.kind, 'ask_human');
    if (call.kind === 'ask_human') assert.equal(call.questions.length, 2);
    return { 'guided-question-0': ['5000'], 'guided-question-1': [] };
  };
  const result = await new GuidedAskExecutor(host).run(request(root), h);
  assert.equal(result.ok, false); assert.equal(result.modelRequests, 0);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8'))[0]?.answer, '5000');
  assert.ok(readFileSync(paths.intent, 'utf8').includes('[x] [блокирующий] Порог?'));
  assert.ok(readFileSync(paths.explorationReport, 'utf8').includes('[ ] [блокирующий] Валюта?'));
  h.onAskHuman = async () => ({ 'guided-question-0': ['рубли'] });
  assert.equal((await new GuidedAskExecutor(host).run(request(root), h)).ok, true);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8')).length, 2);
});

test('guided Ask delivers every unresolved question in batches of four', async t => {
  const { root, paths } = fixture(t);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n' + Array.from({ length: 9 }, (_, i) => `- [ ] [блокирующий] Правило ${i + 1}?`).join('\n'));
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); const batches: string[][] = [];
  h.onAskHuman = async call => {
    assert.equal(call.kind, 'ask_human');
    if (call.kind !== 'ask_human') return {};
    batches.push(call.questions.map(q => q.id));
    return Object.fromEntries(call.questions.map(q => [q.id, [`ответ ${q.id}`]]));
  };
  const result = await new GuidedAskExecutor(host).run(request(root), h);
  assert.equal(result.ok, true);
  assert.deepEqual(batches.map(batch => batch.length), [4, 4, 1]);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8')).length, 9);
});

test('source answers require a cited range inside the shown source and never become human testimony', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Порог равен 5000 граммов.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Порог?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async () => { throw new Error('protocol failure is not a business question'); };
  const options = { provider: provider([{ kind: 'source', source: 'request-1', lines: [2, 5], answer: '6000' }]), params: null, contextWindow: 16384 };
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).ok, false);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8')).length, 0);
  assert.ok(!readFileSync(paths.clarificationReport, 'utf8').includes('6000'));
  const second = fixture(t);
  initializePreparation(second.paths, 'Порог равен 5000 граммов.', 3);
  writeArtifact(second.paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Порог?\n');
  const secondHost = { paths: second.paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  h.onAskHuman = async () => { throw new Error('source answer should resolve this question'); };
  options.provider = provider([{ kind: 'source', source: 'request-1', lines: [1, 1], answer: '5000' }]);
  assert.equal((await new GuidedAskExecutor(secondHost, options).run(request(second.root), h)).ok, true);
  const report = readFileSync(second.paths.clarificationReport, 'utf8');
  assert.equal(extractHumanFacts(report).length, 0);
  assert.ok(report.includes('request-1'));
  assert.ok(report.includes('Порог равен 5000 граммов.'), 'рантайм подставил дословную цитату по ссылке');
  assert.ok(report.includes('5000'));
});

test('a cited statement that policy is unknown is forwarded to the human', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Для silver правило льготы не записано в документах.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Какое правило для silver?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async call => {
    assert.equal(call.kind, 'ask_human');
    return { 'guided-question-0': ['silver gets the tier 2 benefit'] };
  };
  const options = { provider: provider([{ kind: 'source', source: 'request-1',
    lines: [1, 1], answer: 'silver gets no benefit' }]), params: null, contextWindow: 16384 };
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).ok, true);
  const report = readFileSync(paths.clarificationReport, 'utf8');
  assert.equal(extractHumanFacts(report)[0]?.answer, 'silver gets the tier 2 benefit');
  assert.ok(!report.includes('silver gets no benefit'));
});

test('engineering choices persist on resume and are revalidated after source changes', async t => {
  const { root, paths } = fixture(t);
  const original = 'Добавить комментарии к DAILY_ISSUE_LIMIT: объяснить причины лимитов.';
  initializePreparation(paths, original, 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Как оформить комментарии к DAILY_ISSUE_LIMIT?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async () => { throw new Error('style must not require a human'); };
  const options = { provider: provider([{ kind: 'engineering', source: 'request-1', lines: [1, 1],
    category: 'comment', choice: 'Короткое объяснение причины рядом с каждой записью', reason: 'Запрос требует объяснить причины, точная форма свободна' }]), params: null, contextWindow: 16384 };
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).ok, true);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'engineering');
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8')).length, 0);
  options.provider = { ...options.provider, chat: async () => { throw new Error('must reuse saved decision'); } };
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).modelRequests, 0);
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, requests: ['Комментарии к DAILY_ISSUE_LIMIT должны дословно цитировать требования.'] });
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).ok, false);
  assert.ok(readFileSync(paths.intent, 'utf8').includes('[ ] [блокирующий]'));
});

test('context requests read the project and save a cited answer before resuming', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Проверить значение LIMIT в a.ts.', 3);
  const source = 'export const LIMIT = 5000;';
  writeFileSync(join(root, 'a.ts'), source);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Какое значение LIMIT в a.ts?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async () => { throw new Error('code lookup is not a human question'); };
  const options = { provider: provider([{ kind: 'context', path: 'a.ts', reason: 'Нужно прочитать значение' },
    { kind: 'source', source: 'a.ts', lines: [1, 1], answer: '5000' },
    { kind: 'source', source: 'a.ts', lines: [1, 1], answer: '6000' }]), params: null, contextWindow: 16384 };
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).ok, true);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.citations[0]?.source, 'a.ts');
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.citations[0]?.quote, source, 'рантайм отрендерил цитату по ссылке');
  assert.equal(preparation(paths)?.readEvidence?.find(entry => entry.path === 'a.ts')?.stage, 'ask');
  assert.equal((await new GuidedAskExecutor(host, options).run(request(root), h)).modelRequests, 0);
  writeFileSync(join(root, 'a.ts'), 'export const LIMIT = 6000;');
  // Источник изменился: сохранённое решение инвалидировано и переспросилось у модели,
  // цитата перерендерилась из новых байт — протокол не позволяет сослаться на старый текст.
  const revalidated = await new GuidedAskExecutor(host, options).run(request(root), h);
  assert.equal(revalidated.ok, true);
  assert.equal(revalidated.modelRequests, 1);
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.citations[0]?.quote, 'export const LIMIT = 6000;');
});

test('partial plan repair preserves unaffected cards and assigns new IDs in runtime', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'LIMIT', action: 'change limit', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, { ...step, id: 2, file: 'b.ts' }],
    excluded: [], axes: [], changes: 'none' });
  const repair = { steps: [{ ...step, action: 'correct limit' }, { ...step, id: 0, file: 'new.test.ts', isNew: true }],
    removeSteps: [], approach: null, axes: null, excluded: null, changes: null };
  const result = applyGuidedPlanRepair(plan, repair, [1]);
  assert.deepEqual(result.steps[1], plan.steps[1]);
  assert.equal(result.steps[2]?.id, 3);
  assert.equal(result.steps[0]?.action, 'correct limit');
  assert.deepEqual(applyGuidedPlanRepair(plan, { ...repair, steps: [{ ...step, id: 2 }], approach: 'unrequested change' }, [1]), plan);
  assert.throws(() => applyGuidedPlanRepair(plan, { ...repair, removeSteps: [9] }), /отсутствует/);
  const replacement = applyGuidedPlanRepair(plan, { ...repair, removeSteps: [1], steps: [{ ...step, id: 0, action: 'replace the card' }] }, [1]);
  assert.equal(replacement.steps[0]?.id, 1);
  assert.equal(replacement.steps[0]?.action, 'replace the card');
  assert.equal(replacement.steps.length, 2);
});

test('repair renumbers deleted cards and dependency references together', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'n', action: 'change n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, { ...step, id: 3, file: 'b.ts', dependsOn: [1] },
    { ...step, id: 5, file: 'c.ts', dependsOn: [3] }], excluded: [], axes: [], changes: 'none' });
  const result = renumberGuidedPlan(plan);
  assert.deepEqual(result.steps.map(s => [s.id, s.dependsOn]), [[1, []], [2, [1]], [3, [2]]]);
  assert.throws(() => renumberGuidedPlan({ ...plan, steps: [step, { ...step, id: 5, dependsOn: [4] }] }), /отсутствующую/);
  assert.throws(() => renumberGuidedPlan({ ...plan, steps: [step, step] }), /Повтор/);
});

test('runtime derives file creation from the filesystem and rejects outside paths', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'a.ts'), 'export const n = 1;');
  const step = { id: 1, file: 'a.ts', isNew: true, symbol: 'n', action: 'change n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, { ...step, id: 2, file: 'new.test.ts', isNew: false }], excluded: [], axes: [], changes: 'none' });
  assert.deepEqual(assignGuidedPlanFileState(plan, root).steps.map(card => card.isNew), [false, true]);
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...step, symbol: "export { rule } from './rule.ts';" }] }, root).steps[0]?.symbol, 'новый: rule');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...step, symbol: 'export', action: 'Реэкспорт функции rule' }] }, root).steps[0]?.symbol, 'новый: rule');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...step, symbol: 'reexport rule', action: 'Реэкспорт функции rule' }] }, root).steps[0]?.symbol, 'новый: rule');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...step, symbol: 'reexport other', action: 'Реэкспорт функции rule' }] }, root).steps[0]?.symbol, 'reexport other');
  assert.equal(assignGuidedPlanFileState({ ...plan, steps: [{ ...step, symbol: 'export', action: 'Реэкспорт функций rule и other' }] }, root).steps[0]?.symbol, 'n');
  assert.throws(() => assignGuidedPlanFileState({ ...plan, steps: [{ ...step, file: '../outside.ts' }] }, root));
});

test('coverage stays mandatory after runtime cards and identifies missing claim IDs', () => {
  const step = { id: 1, file: 'a.ts', isNew: true, symbol: 'n', action: 'create n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'new', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'invariant' })), changes: 'none' });
  const claims = ['claim-1', 'claim-2'].map(id => ({ id, behavior: 'required', procedure: 'test', expected: 'pass' }));
  assert.throws(() => renderGuidedPlan(plan, 'case', claims), /claim-2/);
  assert.ok(renderGuidedPlan(plan, 'case', claims, { deferCoverageUntilRuntimeCards: true }));
  assert.throws(() => validateGuidedPlanCoverage(plan, claims), /claim-2/);
  assert.doesNotThrow(() => validateGuidedPlanCoverage({ ...plan, steps: [...plan.steps, { ...step, id: 2, file: 'new.test.ts', claims: ['claim-2'] }] }, claims));
});

test('duplicate-card repair includes the retained owner and resolves a new ID only after explicit removal', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'n', action: 'change n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, { ...step, id: 2, file: 'b.ts' }, { ...step, id: 3 }], excluded: [], axes: [], changes: 'none' });
  const targets = guidedPlanRepairTargets(plan, 'шаг 3: путь a.ts уже покрыт другой карточкой');
  assert.deepEqual(new Set(targets), new Set([1, 3]));
  assert.deepEqual(new Set(guidedPlanRepairTargets(plan, 'Plan Step\u202f3 must be merged')), new Set([1, 3]));
  const repair = { steps: [{ ...step, id: 0, action: 'combine both changes' }], removeSteps: [3], approach: null, axes: null, excluded: null, changes: null };
  const result = applyGuidedPlanRepair(plan, repair, targets);
  assert.deepEqual(result.steps.map(card => card.id), [1, 2]);
  assert.equal(result.steps[0]?.action, 'combine both changes');
  assert.deepEqual(result.steps[1], plan.steps[1]);
  assert.throws(() => applyGuidedPlanRepair(plan, { ...repair, removeSteps: [] }, targets), /неоднозначен/);
});

test('merging duplicate cards redirects dependent steps to the explicitly repaired owner', () => {
  const step = { id: 1, file: 'a.ts', isNew: true, symbol: 'n', action: 'constant', claims: ['claim-1'],
    check: 'test', expected: 'pass', contract: 'add', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'implement', steps: [step, { ...step, id: 2, action: 'function' },
    { ...step, id: 3, file: 'index.ts', action: 'export both', dependsOn: [2] }], excluded: [], axes: [], changes: 'none' });
  const repair = { steps: [{ ...step, action: 'constant and function' }], removeSteps: [2], approach: null, axes: null, excluded: null, changes: null };
  const result = renumberGuidedPlan(applyGuidedPlanRepair(plan, repair, [1, 2]));
  assert.deepEqual(result.steps[1]?.dependsOn, [1]);
  assert.equal(result.steps[1]?.action, 'export both');
  assert.throws(() => renumberGuidedPlan(applyGuidedPlanRepair(plan, { ...repair, steps: [] }, [1, 2])), /отсутствующую карточку/);
  const unchangedOwner = renumberGuidedPlan(applyGuidedPlanRepair(plan, { ...repair, steps: [step] }, [1, 2]));
  assert.deepEqual(unchangedOwner.steps[1]?.dependsOn, [1]);
  const merge = guidedDuplicateMerge(plan, 'шаг 2: путь a.ts уже покрыт другой карточкой');
  assert.deepEqual(merge?.remove, [2]);
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1, 2], ['a.ts'], [], 'steps', merge) as any;
  assert.equal(format.json_schema.schema.properties.steps.minItems, 1);
  assert.equal(format.json_schema.schema.properties.steps.maxItems, 1);
  assert.equal(format.json_schema.schema.properties.steps.items.properties.id.const, 1);
  assert.deepEqual(format.json_schema.schema.properties.removeSteps.const, [2]);
});

test('an explicit planned export requires compatibility impact before implementation', () => {
  const step = { id: 1, file: 'index.ts', isNew: false, symbol: 'export newFeature', action: 'add export',
    claims: ['claim-1'], check: 'test', expected: 'pass', contract: 'add', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'implement', steps: [step], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'none', outcome: 'claim-1' })), changes: 'none' });
  assert.match(guidedPlanKnownImpactProblem(plan)!, /Совместимость и данные/);
  assert.equal(guidedPlanKnownImpactProblem({ ...plan, axes: plan.axes.map(a => ({ ...a, affected: a.name === 'Совместимость и данные' })) }), null);
  assert.equal(guidedPlanKnownImpactProblem({ ...plan, steps: [] }), null);
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1], undefined, [], 'axes', null, true) as any;
  const axes = format.json_schema.schema.properties.axes.items.oneOf;
  assert.equal(axes.find((a: any) => a.properties.name.const === 'Совместимость и данные').properties.affected.const, true);
  assert.ok(axes.find((a: any) => a.properties.name.const === 'Безопасность').properties.affected.const === undefined);
});

test('compatibility outcome includes claims attached to public API cards', () => {
  const source = { id: 1, file: 'src/issue-limits.ts', isNew: true, symbol: 'DAILY_ISSUE_LIMIT, issue',
    action: 'implement', claims: ['claim-1'], check: 'tests', expected: 'pass',
    contract: 'new export, no consumers yet', dependsOn: [] };
  const api = { ...source, id: 2, file: 'src/index.ts', isNew: false, symbol: 'issue', action: 're-export',
    claims: ['claim-2'], contract: 'extend public API', dependsOn: [1] };
  const axes = AXES.map(name => ({ name, affected: name === 'Совместимость и данные', reason: 'public additions',
    outcome: name === 'Совместимость и данные' ? 'claim-2' : 'not affected' }));
  const plan = parseGuidedPlan({ approach: 'implement', steps: [source, api], excluded: [], axes, changes: 'add' });
  const completed = guidedPlanPublicApiClaims(plan);
  assert.match(completed.axes.find(row => row.name === 'Совместимость и данные')!.outcome, /claim-1/u);
  assert.match(completed.axes.find(row => row.name === 'Совместимость и данные')!.outcome, /claim-2/u);
  assert.match(completed.axes.find(row => row.name === 'Совместимость и данные')!.outcome, /DAILY_ISSUE_LIMIT, issue/u);
  assert.match(completed.axes.find(row => row.name === 'Совместимость и данные')!.outcome, /existing exports remain unchanged/u);
  assert.equal(guidedPlanKnownImpactProblem(completed), null);
  const newPrefix = { ...plan, steps: [{ ...source, symbol: 'new: issue' }] };
  assert.match(guidedPlanPublicApiClaims(newPrefix).axes.find(row => row.name === AXES[4])!.outcome, /issue/u);
  const dependent = { ...plan, steps: [{ ...source, symbol: 'findEntry', action: 'call findEntry and map null result' }] };
  const dependencyImpacted = guidedPlanDependencyClaims(dependent);
  assert.equal(dependencyImpacted.axes.find(row => row.name === AXES[2])!.affected, true);
  assert.match(dependencyImpacted.axes.find(row => row.name === AXES[2])!.outcome, /claim-1/u);
  const viaApproach = guidedPlanDependencyClaims({ ...plan, approach: 'Implement issue with existing findEntry helper',
    steps: [{ ...source, symbol: 'issue', action: 'implement issue' }] });
  assert.equal(viaApproach.axes.find(row => row.name === AXES[2])!.affected, true);
});

test('large unapproved guided plan revisions archive the prior plan before replacement', t => {
  const { paths } = fixture(t);
  const prior = ['<!-- sdlc-template: plan v1 -->', '- **Одобрение:** не одобрен', ...Array.from({ length: 250 }, (_, i) => `old plan detail ${i}`)].join('\n');
  writeFileSync(paths.plan, prior, 'utf8');
  const archive = archiveReplacedGuidedPlan(paths, Array.from({ length: 70 }, (_, i) => `new plan ${i}`).join('\n'));
  assert.equal(archive, paths.planArchive(1));
  assert.equal(existsSync(paths.plan), false);
  assert.equal(readFileSync(archive!, 'utf8'), prior);
});

test('validation plans mark security impact with attached claims', () => {
  const source = { id: 1, file: 'src/validate.ts', isNew: true, symbol: 'validateCustomer', action: 'implement validation',
    claims: ['claim-1', 'claim-2'], check: 'tests', expected: 'pass', contract: 'pure validation', dependsOn: [] };
  const testStep = { ...source, id: 2, file: 'test\\validate.test.ts', symbol: 'validateCustomer tests', action: 'write unit tests',
    claims: ['claim-1', 'claim-2'], check: 'test valid and invalid prefixes', expected: 'all tests pass', contract: 'new tests', dependsOn: [1] };
  const plan = parseGuidedPlan({ approach: 'validate', steps: [source, testStep], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'not changed', outcome: 'н/п — not changed' })), changes: 'none' });
  const secured = guidedPlanSecurityClaims(plan);
  assert.equal(secured.axes.find(axis => axis.name === 'Безопасность')?.affected, true);
  assert.match(secured.axes.find(axis => axis.name === 'Безопасность')!.outcome, /claim-1/);
});

test('runtime-added plan cards must pass the same field validation before approval', () => {
  const plan = parseGuidedPlan({ approach: 'implement', steps: [], excluded: [], axes: [], changes: 'none' });
  const card = { id: 3, file: 'test/new.test.ts', isNew: true, symbol: '', action: 'add tests', claims: ['claim-1'],
    check: 'tests', expected: 'pass', contract: 'test only', dependsOn: [] };
  assert.match(guidedPlanFieldsProblem({ ...plan, steps: [card] })!, /шаг 3: symbol/);
  assert.match(guidedPlanFieldsProblem({ ...plan, steps: [{ ...card, symbol: '‹символ›' }] })!, /плейсхолдер/);
  assert.equal(guidedPlanFieldsProblem({ ...plan, steps: [{ ...card, symbol: 'новый: tests' }] }), null);
});

test('repair recovers repeated transport IDs by file without changing unrelated cards', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'n', action: 'change n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, { ...step, id: 2, file: 'b.ts' }], excluded: [], axes: [], changes: 'none' });
  const result = applyGuidedPlanRepair(plan, { steps: [{ ...step, action: 'correct n' }, { ...step, file: 'b.ts', action: 'unrequested' },
    { ...step, id: 0, file: 'N/A', symbol: 'N/A', action: 'N/A', check: 'N/A', expected: 'N/A', contract: 'N/A' }],
    removeSteps: [1], approach: null, axes: null, excluded: null, changes: null }, [1]);
  assert.equal(result.steps[0]?.action, 'correct n');
  assert.deepEqual(result.steps[1], plan.steps[1]);
  assert.equal(result.steps.length, 2);
});

test('explicit deletion wins over an unchanged copied card in a repair', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'n', action: 'change n', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const obsolete = { ...step, id: 2, file: 'obsolete.ts' };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step, obsolete], excluded: [], axes: [], changes: 'none' });
  const result = applyGuidedPlanRepair(plan, { steps: [step, obsolete], removeSteps: [2],
    approach: null, axes: null, excluded: null, changes: null }, [2]);
  assert.deepEqual(result.steps, [step]);
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1, 2], ['a.ts', 'obsolete.ts']) as any;
  assert.deepEqual(format.json_schema.schema.properties.steps.items.properties.id.enum, [1, 2]);
  assert.deepEqual(format.json_schema.schema.properties.steps.items.properties.file.enum, ['a.ts', 'obsolete.ts']);
  const protectedFormat = guidedPlanRepairResponseFormat(['claim-1'], [1, 2], ['a.ts', 'obsolete.ts'], [1]) as any;
  assert.deepEqual(protectedFormat.json_schema.schema.properties.removeSteps.items.enum, [2]);
  const allProtected = guidedPlanRepairResponseFormat(['claim-1'], [1], ['a.ts'], [1]) as any;
  assert.equal(allProtected.json_schema.schema.properties.removeSteps.maxItems, 0);
});

test('repair schema isolates approach from addressed step fields', () => {
  const approach = guidedPlanRepairResponseFormat(['claim-1'], [1], undefined, [1], 'approach') as any;
  const a = approach.json_schema.schema.properties;
  assert.equal(a.steps.maxItems, 0); assert.equal(a.removeSteps.maxItems, 0);
  assert.equal(a.approach.type, 'string'); assert.equal(a.axes.type, 'null');
  const step = guidedPlanRepairResponseFormat(['claim-1'], [2], ['b.ts'], [2], 'steps') as any;
  const s = step.json_schema.schema.properties;
  assert.equal(s.steps.maxItems, 1); assert.equal(s.steps.minItems, 1);
  assert.deepEqual(s.steps.items.properties.id.enum, [2]);
  assert.equal(s.approach.type, 'null');
  const plan = parseGuidedPlan({ approach: 'change', steps: [{ id: 2, file: 'b.ts', isNew: false, symbol: 'n',
    action: 'change n', claims: ['claim-1'], check: 'test', expected: 'pass', contract: 'unchanged', dependsOn: [] }], excluded: [], axes: [], changes: 'none' });
  assert.deepEqual(guidedPlanRepairTargets(plan, 'Проверка в шаге №2 не покрывает требование'), [2]);
});

test('runtime cards join the repair candidate with stable IDs and preserve successive repairs', () => {
  const step = { id: 1, file: 'a.ts', isNew: false, symbol: 'LIMIT', action: 'change limit', claims: ['claim-1'],
    check: 'npm test', expected: 'pass', contract: 'unchanged', dependsOn: [] };
  const plan = parseGuidedPlan({ approach: 'change', steps: [step], excluded: [],
    axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'invariant' })), changes: 'none' });
  const rendered = renderGuidedPlan(plan, 'case', [{ id: 'claim-1', behavior: 'limit', procedure: 'test', expected: 'pass' }]);
  const runtime = rendered.replace('## files_to_touch', '### Шаг 2 — Добавить экспорт\n- файл: index.ts (существующий)\n- символ: новый: LIMIT\n- действие: ‹действие›\n- закрывает: ‹claim-N›\n- проверка: ‹проверка› · ожидаемо: ‹результат›\n- контракт: ‹контракт›\n- зависит от: 1\n\n### Шаг 3 — Добавить тест\n- файл: new.test.ts (новый)\n- символ: новый: тест\n- действие: ‹действие›\n- закрывает: ‹claim-N›\n- проверка: ‹проверка› · ожидаемо: ‹результат›\n- контракт: ‹контракт›\n- зависит от: 1\n\n## files_to_touch');
  const candidate = incorporateRuntimePlanCards(plan, runtime);
  assert.deepEqual(candidate.steps.map(s => s.id), [1, 2, 3]);
  assert.deepEqual(candidate.steps[0], step);
  const repair = { steps: [{ ...step, id: 2, file: 'index.ts', action: 'export LIMIT', dependsOn: [1] }],
    removeSteps: [], approach: null, axes: null, excluded: null, changes: null };
  const repaired = applyGuidedPlanRepair(candidate, repair, [2]);
  assert.equal(repaired.steps[1]?.action, 'export LIMIT');
  assert.equal(repaired.steps[2]?.action, '');
  const final = applyGuidedPlanRepair(repaired, { ...repair, steps: [{ ...step, id: 3, file: 'new.test.ts', isNew: true }] }, [3]);
  assert.equal(parseGuidedPlan(final).steps.length, 3);
  assert.equal(final.steps[1]?.action, 'export LIMIT');
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1, 2, 3]) as { json_schema: { schema: { properties: { steps: { items: { properties: { id: { enum: number[] }; claims: { items: { enum: string[] } } } } } } } } };
  assert.deepEqual(format.json_schema.schema.properties.steps.items.properties.id.enum, [0, 1, 2, 3]);
  assert.deepEqual(format.json_schema.schema.properties.steps.items.properties.claims.items.enum, ['claim-1']);
});

test('a resolved candidate survives cancellation before the next question', async t => {
  const { root, paths } = fixture(t);
  const source = 'Порог равен 5000 граммов.';
  initializePreparation(paths, source, 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Порог?\n- [ ] [блокирующий] Валюта?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const controller = new AbortController(); let calls = 0;
  const model = provider([{ kind: 'source', source: 'request-1', lines: [1, 1], answer: '5000' }]);
  const chat = model.chat.bind(model);
  model.chat = async input => { if (++calls === 2) { controller.abort(); controller.signal.throwIfAborted(); } return chat(input); };
  await assert.rejects(new GuidedAskExecutor(host, { provider: model, params: null, contextWindow: 16384 }).run({ ...request(root), signal: controller.signal }, hooks()));
  assert.equal(preparation(paths)?.questionJournal?.entries[0]?.status, 'source');
  assert.ok(readFileSync(paths.clarificationReport, 'utf8').includes('5000'));
});

test('a real business choice reaches the human with alternatives and preserves literal testimony', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Добавить льготу для silver, размер требует решения.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [ ] [блокирующий] Какой размер льготы silver?\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async call => {
    assert.equal(call.kind, 'ask_human');
    if (call.kind === 'ask_human') assert.equal(call.questions[0]?.options.length, 2);
    return { 'guided-question-0': ['15%'] };
  };
  const model = provider([{ kind: 'human', missingDecision: 'Размер льготы', options: ['10%', '15%'], consequence: 'Разная итоговая цена', reason: 'Размер не задан' }]);
  assert.equal((await new GuidedAskExecutor(host, { provider: model, params: null, contextWindow: 16384 }).run(request(root), h)).ok, true);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8'))[0]?.answer, '15%');
});

test('failed plan JSON keeps the raw candidate and error without writing a plan', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Add a module.', 3);
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, canonical: { requirements: { documentHash: 'test', acceptance: [], basis: [],
    constraints: { inScope: [], outOfScope: [], invariants: [], assumptions: [], questions: [] } } } });
  const raw = '{"approach":"unfinished';
  const model = { ...provider([]), chat: async () => ({ text: raw, toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() }) } as ChatProvider;
  const result = await new GuidedPlanExecutor({ paths, provider: model, params: null, contextWindow: 16384, slug: 'case' })
    .run({ ...request(root), maxTurns: 1 }, hooks());
  assert.equal(result.ok, false);
  assert.equal(preparation(paths)?.planCandidates?.at(-1)?.raw, raw);
  assert.ok(preparation(paths)?.planCandidates?.at(-1)?.error);
  assert.equal(existsSync(paths.plan), false);
});

test('legacy source reports retain historical evidence and require revalidation', async t => {
  const { root, paths } = fixture(t);
  initializePreparation(paths, 'Порог равен 5000 граммов.', 3);
  writeArtifact(paths.intent, '# Task\n## Открытые вопросы\n- [x] [блокирующий] Порог?\n');
  writeArtifact(paths.clarificationReport, '# Clarifications\n## Ответы из источников\n| Вопрос | Ответ модели | Источник | Цитата |\n|---|---|---|---|\n| Порог? | 5000 | request-1 | Порог равен 5000 граммов. |\n');
  const host = { paths, slug: 'case', writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
  const h = hooks(); h.onAskHuman = async () => { throw new Error('legacy model answer is not human testimony'); };
  const result = await new GuidedAskExecutor(host).run(request(root), h);
  assert.equal(result.ok, false);
  assert.equal(extractHumanFacts(readFileSync(paths.clarificationReport, 'utf8')).length, 0);
  assert.ok(readFileSync(paths.clarificationReport, 'utf8').includes('Порог равен 5000 граммов.'));
  assert.ok(readFileSync(paths.intent, 'utf8').includes('[ ] [блокирующий]'));
});

test('plan symbol accepts a structured new-symbol object and renders it as новый: имя', () => {
  const plan = parseGuidedPlan({ approach: 'add', steps: [{ id: 1, file: 'src/new.ts', isNew: true,
    symbol: { isNew: true, name: 'validateCustomer' }, action: 'implement', claims: ['claim-1'], check: 'test',
    expected: 'pass', contract: 'new', dependsOn: [] }], excluded: [], axes: [], changes: 'none' });
  assert.equal(plan.steps[0]?.symbol, 'новый: validateCustomer');
  assert.throws(() => parseGuidedPlan({ approach: 'add', steps: [{ id: 1, file: 'src/new.ts', isNew: true,
    symbol: { isNew: true, name: 'not an identifier!' }, action: 'implement', claims: ['claim-1'], check: 'test',
    expected: 'pass', contract: 'new', dependsOn: [] }], excluded: [], axes: [], changes: 'none' }));
});

test('plan and repair schemas never emit empty enums for Ollama compatibility', () => {
  for (const format of [
    guidedPlanResponseFormat([], []),
    guidedPlanRepairResponseFormat([], [], [], [], 'steps'),
    guidedPlanRepairResponseFormat(['claim-1'], [1], ['a.ts'], [1]),
  ]) assert.ok(!JSON.stringify(format).includes('"enum":[]'), JSON.stringify(format).slice(0, 400));
});

test('untouched plan paths are not a scope violation when the tree is unchanged', () => {
  const gate = (status: string) => ({ status }) as never;
  assert.deepEqual(chunkScopeSignals(gate('✅'), gate('❌')), { scopeViolation: false, planPathsUntouched: true });
  assert.deepEqual(chunkScopeSignals(gate('❌'), gate('✅')), { scopeViolation: true, planPathsUntouched: false });
  assert.deepEqual(chunkScopeSignals(null, null), { scopeViolation: false, planPathsUntouched: false });
});
