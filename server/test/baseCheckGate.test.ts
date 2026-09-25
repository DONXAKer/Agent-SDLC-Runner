/**
 * Гейт «Тесты красные на базе» — порт `base-check.py`: тестовые hunk'и попытки на чистой
 * базе обязаны дать новые падения (✅), иначе тесты зелёные до правки кода и ничего не
 * доказывают (❌). На настоящем git-репозитории и настоящем раннере — крошечном node-скрипте,
 * печатающем `FAIL: <имя>` в формате, который гейт разбирает.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { baseCheckGate, failuresOf } from '../src/gates/builtin/baseCheck.ts';
import { builtinFor } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import { git } from '../src/gates/git.ts';
import { testOnlyPatch } from '../src/diff/testPath.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const RUNNER = [
  "const fs = require('fs'); const path = require('path');",
  "const dir = path.join(__dirname, 'tests'); let failed = 0;",
  "for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {",
  "  try { require(path.join(dir, f)); console.log('ok ' + f); }",
  "  catch (e) { failed++; console.log('FAIL: ' + f + ' ' + e.message); }",
  '}',
  'process.exit(failed === 0 ? 0 : 1);',
  '',
].join('\n');

async function repo(): Promise<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-basecheck-'));
  roots.push(root);
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'sdlc@test'], root);
  await git(['config', 'user.name', 'sdlc'], root);
  await git(['config', 'core.autocrlf', 'false'], root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'run-tests.cjs'), RUNNER, 'utf8');
  writeFileSync(join(root, 'src', 'lib.cjs'), 'module.exports = { f: () => 1 };\n', 'utf8');
  writeFileSync(join(root, 'tests', 'a.test.cjs'), "if (require('../src/lib.cjs').f() !== 1) throw new Error('f');\n", 'utf8');
  await git(['add', '-A'], root);
  await git(['commit', '-q', '-m', 'base'], root);
  return { root, base: (await git(['rev-parse', 'HEAD'], root)).stdout.trim() };
}

function ctx(root: string, base: string | null): GateContext {
  return { projectRoot: root, planFiles: [], baseline: null, timeoutMs: 60_000, baseSha: base, testsCommand: 'node run-tests.cjs' };
}

describe('гейт «Тесты красные на базе»', () => {
  it('зарегистрирован под именем перечня', () => {
    ok(builtinFor('Тесты красные на базе') !== null);
  });

  it('тест попытки требует правки кода — на базе он красный: ✅ с именем упавшего', async () => {
    const { root, base } = await repo();
    // Попытка: код возвращает 2 и новый тест это проверяет; на базе (f() === 1) тест падает.
    writeFileSync(join(root, 'src', 'lib.cjs'), 'module.exports = { f: () => 2 };\n', 'utf8');
    writeFileSync(join(root, 'tests', 'a.test.cjs'), "if (require('../src/lib.cjs').f() !== 2) throw new Error('f');\n", 'utf8');
    writeFileSync(join(root, 'tests', 'b.test.cjs'), "if (require('../src/lib.cjs').f() !== 2) throw new Error('claim-1');\n", 'utf8');
    const r = await baseCheckGate(ctx(root, base));
    strictEqual(r.status, '✅', r.lastLine);
    ok((r.evidence ?? []).some((e) => e.includes('b.test.cjs')), JSON.stringify(r.evidence));
  });

  it('новый тест зелёный и на базе — ❌: он ничего не доказывает', async () => {
    const { root, base } = await repo();
    writeFileSync(join(root, 'src', 'lib.cjs'), 'module.exports = { f: () => 1, g: () => 3 };\n', 'utf8');
    writeFileSync(join(root, 'tests', 'b.test.cjs'), "if (1 + 1 !== 2) throw new Error('math');\n", 'utf8');
    const r = await baseCheckGate(ctx(root, base));
    strictEqual(r.status, '❌', r.lastLine);
  });

  it('в патче нет тестовых файлов — ⏭; базы нет — ⏭; worktree за собой убран', async () => {
    const { root, base } = await repo();
    writeFileSync(join(root, 'src', 'lib.cjs'), 'module.exports = { f: () => 1, g: () => 3 };\n', 'utf8');
    const r = await baseCheckGate(ctx(root, base));
    strictEqual(r.status, '⏭');
    ok(r.lastLine.includes('нет тестовых файлов'), r.lastLine);
    strictEqual((await baseCheckGate(ctx(root, null))).status, '⏭');
    const wts = (await git(['worktree', 'list'], root)).stdout.trim().split('\n');
    strictEqual(wts.length, 1, wts.join('\n'));
  });

  it('failuresOf и testOnlyPatch — форматы раннеров и отбор тестовых файлов', () => {
    deepStrictEqual(
      [...failuresOf(['FAILED tests/x.py::test_a', 'FAIL: test_b (mod.Cls)', '  ✕ rounds', 'Class > method FAILED', '--- FAIL: TestGo', 'FAILED (failures=1)'].join('\n'))].sort(),
      ['Class > method', 'TestGo', 'rounds', 'test_b (mod.Cls)', 'tests/x.py::test_a'].sort(),
    );
    const p = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-x', '+y', 'diff --git a/tests/a.test.ts b/tests/a.test.ts', '--- a/tests/a.test.ts', '+++ b/tests/a.test.ts', '@@ -1 +1 @@', '-1', '+2', ''].join('\n');
    const only = testOnlyPatch(p);
    ok(only.startsWith('diff --git a/tests/a.test.ts'), only);
    ok(!only.includes('src/a.ts'));
  });
});
