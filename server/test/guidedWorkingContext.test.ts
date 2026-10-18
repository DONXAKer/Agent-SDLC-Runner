import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGuidedWorkingContext, workingContextCurrent } from '../src/exec/guidedWorkingContext.ts';
import { guidedCapabilities, validateGuidedCapabilities } from '../src/exec/guidedCapabilities.ts';
import { parseBoundGuidedReply, guidedBoundActionResponseFormat } from '../src/exec/GuidedExecutor.ts';
import { observedTestFailures, groundedRepairFeedback, parseRepairDiagnosis } from '../src/exec/repairDiagnosis.ts';
import { preservationConstraint } from '../src/run/preservationConstraint.ts';

test('working packet supplies exact function, imported type and test convention, with fresh source hashes', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-working-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'));
  const customer = 'export interface Customer { email: string; phone: string }\n';
  writeFileSync(join(root, 'src/customer.ts'), customer);
  writeFileSync(join(root, 'src/validate.ts'), "import type { Customer } from './customer.ts';\nexport function validateCustomer(customer: Customer) { return []; }\nexport const unrelated = 999;\n");
  writeFileSync(join(root, 'test/customer.test.ts'), "import { test } from 'node:test';\ntest('Customer fixture', () => {});\n");
  const task = { file: 'src/validate.ts', symbol: 'validateCustomer', action: 'исправить валидацию Customer', claims: ['claim-1'] };
  const packet = buildGuidedWorkingContext(root, [task.file], [task], new Set(['src/customer.ts', 'test/customer.test.ts']));
  assert.ok(packet.fragments.some(fragment => fragment.symbol === 'validateCustomer' && !fragment.text.includes('unrelated')));
  assert.ok(packet.fragments.some(fragment => fragment.role === 'dependency' && fragment.text === customer.trimEnd()));
  assert.ok(packet.fragments.some(fragment => fragment.role === 'test-example' && fragment.text.includes("'node:test'")));
  assert.equal(packet.imports[0]?.resolved, 'src/customer.ts'); assert.equal(workingContextCurrent(root, packet), true);
  writeFileSync(join(root, 'src/customer.ts'), customer.replace('phone: string', 'phone: number'));
  assert.equal(workingContextCurrent(root, packet), false, 'a stale type is not accepted as current evidence');
});

test('working packet does not implicitly read unobserved dependencies and marks incomplete fragments', t => {
  const root = mkdtempSync(join(tmpdir(), 'guided-working-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), "import { secretType } from './b.ts';\nexport function run() { return secretType; }\n");
  writeFileSync(join(root, 'b.ts'), 'export const secretType = "must not be disclosed";\n');
  const packet = buildGuidedWorkingContext(root, ['a.ts'], [{ file: 'a.ts', symbol: 'run', action: 'fix run', claims: [] }], new Set(), '', 20);
  assert.equal(packet.fragments.some(fragment => fragment.path === 'b.ts'), false);
  assert.equal(packet.partial, true); assert.ok(packet.missing.some(item => item.path === 'b.ts'));
  assert.ok(packet.fragments.every(fragment => fragment.partial));
});

test('explicit edit binds the target symbol and rejects destructive operations independently of JSON schema', () => {
  const cards = [{ path: 'a.ts', hash: 'current', isNew: false, symbols: ['n', 'other'] }];
  const capability = guidedCapabilities(cards, [{ file: 'a.ts', symbol: 'n', action: 'исправить n', claims: [] }]);
  assert.deepEqual(capability[0]?.ops, ['replace_body', 'ensure_import']);
  const reply = parseBoundGuidedReply(JSON.stringify({ action: 'patch', prediction: 'two', ops: [{ op: 'replace_body', body: 'export const n = 2;' }] }), 'a.ts', 'n');
  assert.equal(reply.action, 'patch');
  if (reply.action === 'patch') assert.doesNotThrow(() => validateGuidedCapabilities(reply.ops, capability));
  assert.throws(() => validateGuidedCapabilities([{ op: 'delete', file: 'a.ts', symbol: 'n' }], capability), /не разрешена/);
  assert.throws(() => parseBoundGuidedReply(JSON.stringify({ action: 'patch', prediction: 'two', ops: [{ op: 'replace_body', symbol: 'other', body: 'return 2;' }] }), 'a.ts', 'n'), /закреплён/);
  assert.doesNotThrow(() => guidedBoundActionResponseFormat(cards, false, undefined, capability, 'n'));
  const barrel = guidedCapabilities([{ path: 'index.ts', hash: 'b', symbols: ['n'], isNew: false, barrel: true }], [{ file: 'index.ts', symbol: 'n', action: 'реэкспортировать n', claims: [] }]);
  assert.deepEqual(barrel[0]?.ops, ['ensure_reexport']);
});

test('repair feedback contains observed values and exact original predicate, leaving missing input unknown', () => {
  const output = "not ok 1 - accepts phone\n  actual: false\n  expected: true\n";
  const failures = observedTestFailures(output);
  assert.equal(failures[0]?.actual, 'false'); assert.equal(failures[0]?.expected, 'true'); assert.equal(failures[0]?.input, null);
  const requests = ['Phone accepts 8 and exactly 10 following digits.'];
  const diagnosis = parseRepairDiagnosis(JSON.stringify({ kind: 'test-expectation', reason: 'test contradicts source', observedFailure: 'actual: false', source: { request: 1, lines: [1, 1] } }), output, requests);
  const feedback = JSON.parse(groundedRepairFeedback(diagnosis, requests, ['test/new.test.ts'], output));
  assert.equal(feedback.originalPredicate.quote, requests[0]); assert.equal(feedback.observedTestFailures[0].input, null);
});

test('preservation grammar supports unrelated wording and never discharges compound obligations', () => {
  for (const text of ['Не изменять существующие исходники и тесты.', 'Текущие тесты и модули остаются без правок.',
    'Keep existing source files and tests unchanged.', 'Do not modify original tests and code.'])
    assert.deepEqual(preservationConstraint(text), { coversClaim: true }, text);
  assert.deepEqual(preservationConstraint('Keep existing modules and tests unchanged: preserve transaction isolation too.'), { coversClaim: false });
  for (const text of ['Update existing modules and tests.', 'Keep existing modules unchanged.', 'Keep original data and tests unchanged.',
    'Do not change existing modules and tests unless required.', 'Leave tests unchanged if possible.']) assert.equal(preservationConstraint(text), null, text);
});

test('a bound response cannot overwrite a new file repeatedly or mix full and partial writes', () => {
  const capability = [{ file: 'packages/ledger/calculate.ts', ops: ['create_file', 'ensure_import'] }];
  assert.throws(() => validateGuidedCapabilities([
    { op: 'create_file', file: capability[0]!.file, body: 'export const calculate = 1;' },
    { op: 'create_file', file: capability[0]!.file, body: 'export const calculate = 2;' },
  ], capability), /единственной/);
  assert.throws(() => validateGuidedCapabilities([
    { op: 'create_file', file: capability[0]!.file, body: 'export const calculate = 1;' },
    { op: 'ensure_import', file: capability[0]!.file, from: './types.ts', names: ['Item'] },
  ], capability), /единственной/);
  assert.doesNotThrow(() => validateGuidedCapabilities([{ op: 'create_file', file: capability[0]!.file, body: 'export const calculate = 1;' }], capability));
});
