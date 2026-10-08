import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { GuidedExecutor, simulateOps } from '../src/exec/GuidedExecutor.ts';
import { GuidedOpError } from '../src/exec/symbolOps.ts';
import { applyGuidedPlanRepair, guidedPlanRepairPaths, guidedPlanRepairResponseFormat, renumberGuidedPlan, GuidedPlanExecutor } from '../src/exec/GuidedPlanExecutor.ts';
import { applyIntentContractRepair, parseIntentContractReview, renderIntentContractIssue } from '../src/exec/intentContractReview.ts';
import { FormFillExecutor } from '../src/exec/FormFillExecutor.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initGuided } from '../src/run/guidedState.ts';
import { AXES } from '../src/artifacts/planAxes.ts';
import { initializePreparation, preparation, savePreparation, recordPreparationRead } from '../src/artifacts/preparation.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecRequest, ExecHooks } from '../src/exec/StageExecutor.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'guided-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'test'); initGuided(paths, 'local:test');
  return { root, paths };
}
const request = (root: string, artifact?: string): ExecRequest => ({ cwd: root, model: 'test', allowedTools: ['Read', 'Write', 'Edit'],
  signal: new AbortController().signal, maxTurns: 20, maxBudgetUsd: null, prompt: { system: '', user: '' } as ExecRequest['prompt'],
  readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null, ...(artifact ? { formArtifacts: [artifact] } : {}) });
const hooks = (): ExecHooks => ({ onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
  onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {}, onAskHuman: async () => ({}), onRecord: () => '' });
const turn = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const, usage: emptyUsage() });

test('op diagnostics distinguish unknown, ambiguous, outside-group and syntax failures without writing', t => {
  const { root } = fixture(t); const before = 'function store() {\n const n = 1;\n return n;\n}\n// n = 1\n';
  writeFileSync(join(root, 'a.ts'), before);
  const replace = { op: 'replace_body' as const, file: 'a.ts', symbol: 'store', body: 'function store() {\n  return 2;\n}' };
  assert.throws(() => simulateOps(root, ['a.ts'], [{ ...replace, symbol: 'absent' }]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'unknown_symbol');
    assert.equal(error.diagnostic.op, 'replace_body'); assert.deepEqual(error.diagnostic.candidates, ['store']);
    assert.ok(error.diagnostic.snippet?.includes('1: function store')); return true;
  });
  assert.throws(() => simulateOps(root, ['a.ts'], [{ ...replace, file: 'b.ts' }]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'file_outside_group');
    assert.deepEqual(error.diagnostic.candidates, ['a.ts']); return true;
  });
  writeFileSync(join(root, 'b.ts'), 'class A {\n  run() { return 1; }\n}\nclass B {\n  run() { return 2; }\n}\n');
  assert.throws(() => simulateOps(root, ['b.ts'], [{ op: 'delete', file: 'b.ts', symbol: 'run' }]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'ambiguous_symbol');
    assert.deepEqual(error.diagnostic.candidates, ['A.run', 'B.run']); return true;
  });
  assert.throws(() => simulateOps(root, ['b.ts'], [{ op: 'create_file', file: 'b.ts', body: 'export const x = 1;' }]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'not_new_file'); return true;
  });
  assert.throws(() => simulateOps(root, ['c.ts'], [{ op: 'create_file', file: 'c.ts', body: 'export function bad( {' }]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'syntax');
    assert.ok(error.diagnostic.snippet); return true;
  });
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), before);
  assert.equal(existsSync(join(root, 'c.ts')), false);
});

test('sequential drafts and cross-file rename resolve against the simulated state', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'a.ts'), 'export const n = 1;\n');
  // Вторая операция видит результат первой: после rename символа n больше нет.
  assert.throws(() => simulateOps(root, ['a.ts'], [
    { op: 'rename', file: 'a.ts', symbol: 'n', newName: 'm' },
    { op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 2;' },
  ]), error => {
    assert.ok(error instanceof GuidedOpError); assert.equal(error.diagnostic.kind, 'unknown_symbol');
    assert.deepEqual(error.diagnostic.candidates, ['m']); return true;
  });
  // rename экспорта переписывает ссылки в разрешённом импортёре.
  writeFileSync(join(root, 'b.ts'), "import { n } from './a.ts';\nexport const doubled = n * 2;\n");
  const snapshots = simulateOps(root, ['a.ts', 'b.ts'], [{ op: 'rename', file: 'a.ts', symbol: 'n', newName: 'm' }]);
  const b = snapshots.find(s => s.path.endsWith('b.ts'));
  assert.ok(b?.after.includes("import { m } from './a.ts';"));
  assert.ok(b?.after.includes('export const doubled = m * 2;'));
  assert.equal(readFileSync(join(root, 'b.ts'), 'utf8').includes('doubled = n'), true, 'simulate only');
});

test('simulateOps adds explicit .ts extension to bare relative ESM specifiers', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'validate.ts'), 'export function validateCustomer() { return []; }\n');
  writeFileSync(join(root, 'index.ts'), 'const placeholder = 1;\n');
  const snapshots = simulateOps(root, ['index.ts'], [{ op: 'ensure_import' as const, file: 'index.ts', from: './validate', names: ['validateCustomer'] }]);
  const index = snapshots.find(s => s.path.endsWith('index.ts'));
  assert.ok(index?.after.includes("from './validate.ts';"));
  assert.ok(!index?.after.includes("from './validate';"));
});

test('the next model request receives structured op diagnostics and can repair the named symbol', async t => {
  const { root, paths } = fixture(t); const before = 'export const n = 1;\n'; writeFileSync(join(root, 'a.ts'), before);
  let calls = 0;
  const provider = { name: 'spy', async chat(req: any) {
    calls++; const data = JSON.parse(req.messages[1].content);
    if (calls === 2) {
      assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), before);
      assert.equal(data.rejectedProposal.diagnostic.kind, 'unknown_symbol');
      assert.deepEqual(data.rejectedProposal.diagnostic.candidates, ['n']);
    }
    return turn({ action: 'patch', prediction: 'n is two', ops: [calls === 1
      ? { op: 'replace_body', file: 'a.ts', symbol: 'absent', body: 'export const absent = 2;' }
      : { op: 'replace_body', file: 'a.ts', symbol: 'n', body: 'export const n = 2;' }] });
  } } as ChatProvider;
  const result = await new GuidedExecutor({ provider, paths, items: [{ id: 'work-1', title: 'change n', files: ['a.ts'], claims: ['claim-1'],
    dependsOn: [], prediction: 'two', checks: ['test'], status: 'pending', attempts: 0, repartitioned: false }], inputRevision: () => 'r',
    requirements: '', sources: '', contextWindow: 16000, check: async () => ({ passed: true, result: 'pass' }) }).run(request(root), hooks());
  assert.equal(result.ok, true, result.note); assert.equal(calls, 2);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const n = 2;\n');
});

const step = { id: 1, file: 'src/wrong.ts', isNew: false, symbol: 'quoteCommand', action: 'change quote', claims: ['claim-1'],
  check: 'quote', expected: 'json', contract: 'old output kept', dependsOn: [] as number[] };
const plan = { approach: 'Use sources', steps: [step, { ...step, id: 2, file: 'test/new.test.ts', isNew: true, dependsOn: [1] }], excluded: [],
  axes: AXES.map(name => ({ name, affected: false, reason: 'unchanged', outcome: 'unchanged' })), changes: 'none', callers: [] };
const repair = { steps: [{ ...step, file: 'src/commands.ts' }], removeSteps: [], approach: null, axes: null, excluded: null, changes: null };
test('target repair preserves IDs and dependencies and rejects unapproved path changes', () => {
  assert.throws(() => applyGuidedPlanRepair(plan, repair, [1]), /обычный ремонт/u);
  const allowed = new Map([[1, ['src/commands.ts']]]);
  const result = renumberGuidedPlan(applyGuidedPlanRepair(plan, repair, [1], allowed));
  assert.equal(result.steps[0]?.file, 'src/commands.ts'); assert.equal(result.steps[0]?.id, 1);
  assert.deepEqual(result.steps[1]?.dependsOn, [1]);
  assert.throws(() => applyGuidedPlanRepair(plan, { ...repair, steps: [{ ...step, file: 'src/forbidden.ts' }] }, [1], allowed), /не разрешена/u);
  const format = guidedPlanRepairResponseFormat(['claim-1'], [1], ['src/commands.ts'], [], 'target') as any;
  assert.deepEqual(format.json_schema.schema.properties.steps.items.properties.file.enum, ['src/commands.ts']);
});
test('target repair paths exclude forbidden files and existing tests, retaining observed source', t => {
  const { root } = fixture(t); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'));
  for (const file of ['src/commands.ts', 'src/format.ts', 'test/old.test.ts']) writeFileSync(join(root, file), '// source');
  const intent = '## Чего не делаем\nНе меняем src/format.ts.\nНе меняем существующие тесты.\n';
  const allowed = guidedPlanRepairPaths(intent, [], ['src/commands.ts', 'src/format.ts', 'test/old.test.ts'], root);
  assert.deepEqual(allowed, ['src/commands.ts']);
});

test('target repair paths retain plan step files missing from intent and read evidence', t => {
  // src/keys.ts — легитимный файл карточки плана: не назван в «Что делаем» и не читался
  // разведкой, но адресный ремонт обязан уметь сохранить его как прежнюю цель шага.
  const { root } = fixture(t); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/keys.ts'), '// source');
  const allowed = guidedPlanRepairPaths('## Чего не делаем\nНе меняем существующие тесты.\n', [], [], root, ['src/keys.ts']);
  assert.deepEqual(allowed, ['src/keys.ts']);
});

test('Plan executor switches an invalid target to bounded target repair with real source declarations', async t => {
  const { root, paths } = fixture(t); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/wrong.ts'), 'export const old = 1;\n');
  writeFileSync(join(root, 'src/commands.ts'), 'export function quoteCommand() { return 1; }\n');
  initializePreparation(paths, 'Change quoteCommand in src/commands.ts.', 3);
  recordPreparationRead(paths, 'explore', 'src/commands.ts', readFileSync(join(root, 'src/commands.ts'), 'utf8'));
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, canonical: { requirements: { documentHash: 'test', acceptance: [
    { id: 'claim-1', behavior: 'JSON output', procedure: 'quote', expected: 'json' }], basis: [],
    constraints: { inScope: [], outOfScope: [], invariants: [], assumptions: [], questions: [] } } } });
  writeFileSync(paths.intent, '# Task\n## Что делаем\nChange src/commands.ts\n## Чего не делаем\nНе меняем src/wrong.ts.\n');
  let calls = 0;
  const provider = { name: 'target-spy', async chat(req: any) {
    calls++;
    if (calls === 1) return turn({ ...plan, steps: [step] });
    const data = JSON.parse(req.messages[1].content);
    assert.equal(data.repairFocus, 'target'); assert.ok(data.allowedTargetPaths.includes('src/commands.ts'));
    assert.ok(!data.allowedTargetPaths.includes('src/wrong.ts'));
    assert.ok(data.targetDeclarations.find((row: any) => row.file === 'src/commands.ts').declarations[0].includes('quoteCommand'));
    return turn(repair);
  } } as ChatProvider;
  await new GuidedPlanExecutor({ provider, paths, contextWindow: 16000, slug: 'test', params: null })
    .run({ ...request(root), maxTurns: 2 }, hooks());
  assert.equal(calls, 2);
  assert.ok(preparation(paths)?.planCandidates?.some(candidate =>
    (candidate.parsed as typeof plan | undefined)?.steps.some(row => row.id === 1 && row.file === 'src/commands.ts')));
});

const source = 'serialize пишет только sku, code в выводе нет. Старые тесты не менять.';
const intent = '# Задача\n- **Ветка:** sdlc/test\n## Что делаем\nserialize пишет только sku\n\n## Чего не делаем\nНе удаляем code из сериализации\n\n## Приёмочный лист\nclaim-1: serialize не пишет code\n';
// Рецензия адресует строки ссылками, а не байтовыми цитатами: секции «Что делаем» и
// «Чего не делаем» — однострочные, источник request-1 тоже.
const issue = { problem: 'Запрет противоречит сериализации', quotes: [
  { section: 'Что делаем', lines: [1, 1] }, { section: 'Чего не делаем', lines: [1, 1] },
], source: { file: 'request-1', lines: [1, 1] } };
test('contract review requires anchored line references; repair touches only addressed sections', () => {
  const issues = parseIntentContractReview(JSON.stringify({ issues: [issue] }), intent, [source]);
  // Completely malformed review still throws; tolerant clamping only applies to valid issues.
  assert.throws(() => parseIntentContractReview('{}', intent, [source]), /Invalid input|expected array/);
  // Invalid source/section references are skipped rather than burning a repair turn.
  assert.deepStrictEqual(parseIntentContractReview(JSON.stringify({ issues: [{ ...issue, source: { file: 'request-9', lines: [1, 1] } }] }), intent, [source]), []);
  const clampedSource = parseIntentContractReview(JSON.stringify({ issues: [{ ...issue, source: { file: 'request-1', lines: [1, 5] } }] }), intent, [source]);
  assert.deepStrictEqual(clampedSource[0]!.source.lines, [1, 1]);
  const clampedQuote = parseIntentContractReview(JSON.stringify({ issues: [{ ...issue, quotes: [{ section: 'Что делаем', lines: [3, 9] }] }] }), intent, [source]);
  assert.deepStrictEqual(clampedQuote[0]!.quotes[0]!.lines, [3, 3]);
  assert.deepStrictEqual(parseIntentContractReview(JSON.stringify({ issues: [{ ...issue, quotes: [{ section: 'Инварианты', lines: [1, 1] }] }] }), intent, [source]), []);
  const rendered = renderIntentContractIssue(issues[0]!, intent, [source]);
  assert.equal(rendered.quotes[0]!.quote, 'serialize пишет только sku');
  assert.ok(rendered.sourceQuote.includes('serialize пишет только sku, code в выводе нет.'));
  const result = applyIntentContractRepair(intent, JSON.stringify({ sections: [{ section: 'Чего не делаем', content: 'Не меняем старые тесты' }] }), issues);
  assert.ok(result.includes('serialize пишет только sku')); assert.ok(result.includes('claim-1: serialize не пишет code'));
  assert.ok(!result.includes('Не удаляем code')); assert.ok(result.includes('- **Ветка:** sdlc/test'));
  assert.throws(() => applyIntentContractRepair(intent, JSON.stringify({ sections: [{ section: 'Приёмочный лист', content: 'unrequested' }] }), issues));
  assert.throws(() => applyIntentContractRepair(intent, JSON.stringify({ sections: [{ section: 'Чего не делаем', content: '## New section\ntext' }] }), issues));
});

test('complete Intent review repairs through the write gate then independently rechecks', async t => {
  const { root } = fixture(t); const artifact = join(root, 'intent.md'); writeFileSync(artifact, intent);
  let reviews = 0; let writes = 0;
  const provider = { name: 'contract-spy', async chat(req: any) {
    const name = req.params.response_format.json_schema.name;
    if (name === 'intent_contract_review') return turn({ issues: ++reviews === 1 ? [issue] : [] });
    assert.equal(name, 'intent_contract_repair');
    return turn({ sections: [{ section: 'Чего не делаем', content: 'Не меняем старые тесты' }] });
  } } as ChatProvider;
  const h = hooks(); h.onToolResult = () => { writes++; };
  const result = await new FormFillExecutor({ provider, compact: true, preparationV2: true, reviewIntentContract: true, intentRequests: [source],
    stage: 'intent', maxResultBytes: 10000, readRangeRequiredAboveBytes: 10000, bashTimeoutMs: 1000 }).run(request(root, artifact), h);
  assert.equal(result.ok, true, result.note); assert.equal(reviews, 2); assert.equal(writes, 1); assert.equal(result.modelRequests, 3);
  assert.ok(!readFileSync(artifact, 'utf8').includes('Не удаляем code'));
});

test('Intent blocks malformed review, exhausted repairs, write denial and exhausted request cap', async t => {
  const { root } = fixture(t); const artifact = join(root, 'intent.md');
  for (const scenario of ['malformed', 'exhausted', 'denied', 'budget'] as const) {
    writeFileSync(artifact, intent); let repairs = 0;
    const provider = { name: 'failure-spy', async chat(req: any) {
      if (scenario === 'malformed') return turn({});
      if (req.params.response_format.json_schema.name === 'intent_contract_review') return turn({ issues: [{ ...issue,
        quotes: [{ section: 'Что делаем', lines: [1, 1] }], problem: 'ещё противоречие' }] });
      repairs++; return turn({ sections: [{ section: 'Что делаем', content: `serialize пишет только sku\nУточнение ${repairs}` }] });
    } } as ChatProvider;
    const h = hooks(); if (scenario === 'denied') h.onToolRequest = async () => ({ allowed: false, updatedInput: null, reason: 'denied', by: 'policy' });
    const result = await new FormFillExecutor({ provider, compact: true, preparationV2: true, reviewIntentContract: true, intentRequests: [source], stage: 'intent',
      maxResultBytes: 10000, readRangeRequiredAboveBytes: 10000, bashTimeoutMs: 1000 }).run({ ...request(root, artifact), ...(scenario === 'budget' ? { requestCap: 1 } : {}) }, h);
    assert.equal(result.ok, false, scenario); assert.ok(repairs <= 2);
    if (scenario === 'malformed' || scenario === 'denied' || scenario === 'budget') assert.equal(readFileSync(artifact, 'utf8'), intent);
    if (scenario === 'exhausted') assert.equal(repairs, 2);
  }
});
