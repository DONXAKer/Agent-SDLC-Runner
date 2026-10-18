import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { contractDependencies, checkedIntentContract, sourceScopeIssues, intentClaimSetProblem } from '../src/exec/guidedContract.ts';
import { GuidedOpError } from '../src/exec/symbolOps.ts';
import { simulateOps } from '../src/exec/GuidedExecutor.ts';
import { initGuided } from '../src/run/guidedState.ts';
import { captureInvariantBaseline, checkInvariants, invariantClaimIds } from '../src/run/guidedInvariants.ts';
import { initializePreparation, preparation, savePreparation, seedAcceptanceFromRequests } from '../src/artifacts/preparation.ts';

test('checked intent is observed evidence bound to both exact document and original requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const progress = new GuidedProgress(new WitokPaths(root, 'test'));
  const deps = contractDependencies('intent', ['original']);
  progress.accept(progress.begin('intent:contract-checked', 'intent', deps), { checked: true }, deps);
  assert.equal(checkedIntentContract(progress, 'intent', ['original']), false, 'a proposal is not a completed check');
  progress.accept(progress.begin('intent:contract-checked', 'intent', deps), { checked: true }, deps, true);
  assert.equal(checkedIntentContract(progress, 'intent', ['original']), true);
  assert.equal(checkedIntentContract(progress, 'changed intent', ['original']), false);
  assert.equal(checkedIntentContract(progress, 'intent', ['changed request']), false);
});

test('an invented whole-file exclusion cannot cancel the requested re-export', () => {
  const intent = '## Чего не делаем\n- Не меняем `src/index.ts`.\n';
  const request = 'Реэкспортировать функцию через `src/index.ts`.';
  assert.equal(sourceScopeIssues(intent, [request]).length, 1);
  assert.equal(sourceScopeIssues('## Чего не делаем\n- Не меняем тесты.\n', [request]).length, 0);
  assert.throws(() => sourceScopeIssues(intent, [request + '\nНе меняем `src/index.ts`.']), /требуется уточнение/);
});

test('frozen Ministral failure is reproduced from the original request and actual Intent artifact', () => {
  const directory = new URL('./fixtures/guided-v4/', import.meta.url);
  const intent = readFileSync(new URL('ministral-invented-exclusion.md', directory), 'utf8');
  const source = readFileSync(new URL('original-request.md', directory), 'utf8');
  assert.ok(sourceScopeIssues(intent, [source]).some(issue => issue.problem.includes('src/index.ts')));
});

test('actual local GPT-OSS repair cannot close Intent after dropping claim-5', () => {
  const directory = new URL('./fixtures/guided-v4/', import.meta.url);
  const intent = readFileSync(new URL('gptoss-dropped-claim.md', directory), 'utf8');
  const source = readFileSync(new URL('original-request.md', directory), 'utf8');
  assert.match(intentClaimSetProblem(intent, [source]) ?? '', /claim-5/);
});

test('duplicate delete identifies second operation and its simulated input without writing', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = 'export const bill = 1;\nexport const DEFAULT_CONFIG = {};\n';
  writeFileSync(join(root, 'a.ts'), before);
  assert.throws(() => simulateOps(root, ['a.ts'], [
    { op: 'delete', file: 'a.ts', symbol: 'bill' }, { op: 'delete', file: 'a.ts', symbol: 'bill' },
  ]), error => {
    assert.ok(error instanceof GuidedOpError);
    assert.equal(error.diagnostic.opIndex, 1);
    assert.deepEqual(error.diagnostic.beforeSymbols, ['DEFAULT_CONFIG']);
    assert.ok(error.diagnostic.beforeHash); return true;
  });
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), before);
});

test('invariants use the original snapshot across resume and detect lost exports and changed old tests', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src/index.ts'), "export { add } from './money.ts';\n");
  writeFileSync(join(root, 'src/money.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  writeFileSync(join(root, 'test/money.test.ts'), 'const existingTest = true;\n');
  const paths = new WitokPaths(root, 'test'); initGuided(paths, 'local:test', 4);
  captureInvariantBaseline(paths, root);
  const request = '## Что должно получиться\n1. Реэкспортировать validate через `src/index.ts`.\n2. Существующие модули и тесты не трогаем.\n';
  initializePreparation(paths, request, 3);
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, canonical: { requirements: { documentHash: 'test', acceptance: seedAcceptanceFromRequests([request]), basis: [],
    constraints: { inScope: [], outOfScope: [], invariants: [], assumptions: [], questions: [] } } } });
  assert.deepEqual([...invariantClaimIds(paths)], ['claim-2']);
  assert.equal(checkInvariants(paths, root).passed, true);
  writeFileSync(join(root, 'src/index.ts'), "export { validate } from './validate.ts';\n");
  assert.match(checkInvariants(paths, root).result, /preserved-exports: src\/index.ts/);
  writeFileSync(join(root, 'src/index.ts'), "/* export { add } from './money.ts'; */\nexport { validate } from './validate.ts';\n");
  assert.match(checkInvariants(paths, root).result, /preserved-exports: src\/index.ts/);
  assert.throws(() => captureInvariantBaseline(paths, root), /already exists/);
  writeFileSync(join(root, 'src/index.ts'), "export { add } from './money.ts';\nexport { validate } from './validate.ts';\n");
  assert.equal(checkInvariants(paths, root).passed, true);
  writeFileSync(join(root, 'test/money.test.ts'), '');
  assert.match(checkInvariants(paths, root).result, /unchanged-files: test\/money.test.ts/);
});
