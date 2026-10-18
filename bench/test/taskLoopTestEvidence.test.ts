import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { additionalExecutedTests } from '../src/taskLoopTestEvidence.ts';

const original = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('existing', () => assert.equal(2 + 2, 4));\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'executed-tests-'));
  const baselineDir = join(root, 'baseline'), targetDir = join(root, 'target');
  for (const dir of [baselineDir, targetDir]) { mkdirSync(join(dir, 'spec'), { recursive: true }); writeFileSync(join(dir, 'spec/main.test.mjs'), original); }
  return { baselineDir, targetDir, commandArgs: ['--test', 'spec/*.test.mjs'] };
}
test('new passing cases in an existing allowed file satisfy the test obligation', async () => {
  const f = fixture(); writeFileSync(join(f.targetDir, 'spec/main.test.mjs'), original + "test('additional', () => assert.equal(3 * 3, 9));\n");
  const result = await additionalExecutedTests(f);
  assert.equal(result.passed, true); assert.equal(result.baseline?.passed, 1); assert.equal(result.final?.passed, 2);
});
test('a new non-test file cannot masquerade as a new executed test', async () => {
  const f = fixture(); writeFileSync(join(f.targetDir, 'spec/notes.md'), 'Tests passed');
  assert.equal((await additionalExecutedTests(f)).passed, false);
});
test('skipped or failing added cases do not satisfy the obligation', async () => {
  const f = fixture(); writeFileSync(join(f.targetDir, 'spec/main.test.mjs'), original + "test.skip('skipped', () => {});\n");
  assert.equal((await additionalExecutedTests(f)).passed, false);
  writeFileSync(join(f.targetDir, 'spec/main.test.mjs'), original + "test('failing', () => assert.fail('real failure'));\n");
  assert.equal((await additionalExecutedTests(f)).passed, false);
});
