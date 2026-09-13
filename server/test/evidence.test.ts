/**
 * `recordAttemptEvidence` — статус тестов структурой (`testsStatus`), не только строкой
 * (`testsNote`). Второй разбор `testsNote` регуляркой в `RunMetrics.chunkEvidence` рано или
 * поздно разошёлся бы с текстом, который правится свободно (см. комментарий в `evidence.ts`).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { GateContext } from '../src/gates/builtin/index.ts';
import { git } from '../src/gates/git.ts';
import { recordAttemptEvidence } from '../src/run/evidence.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** `workingDiff` внутри читает git-дерево — голый временный каталог без репозитория. */
async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-evidence-'));
  roots.push(root);
  await git(['init'], root);
  return root;
}

function gateCtx(projectRoot: string): GateContext {
  return { projectRoot, planFiles: [], baseline: null, timeoutMs: 5000 };
}

describe('recordAttemptEvidence: testsStatus структурой', () => {
  it('гейт «Тесты» не в наборе — ⏭, файл-улика тоже это говорит', async () => {
    const root = await repo();
    const diffPath = join(root, 'd.patch');
    const testsPath = join(root, 't.txt');

    const r = await recordAttemptEvidence({
      projectRoot: root,
      diffPath,
      testsPath,
      diffBefore: '',
      gateCtx: gateCtx(root),
      runTests: null,
    });

    strictEqual(r.testsStatus, '⏭');
    strictEqual(r.tree, 'empty');
    strictEqual(readFileSync(testsPath, 'utf8').includes('гейт «Тесты» в наборе не найден'), true);
  });

  it('гейт есть и красный — testsStatus совпадает с тем, что вернул сам гейт', async () => {
    const root = await repo();
    const diffPath = join(root, 'd.patch');
    const testsPath = join(root, 't.txt');

    const r = await recordAttemptEvidence({
      projectRoot: root,
      diffPath,
      testsPath,
      diffBefore: '',
      gateCtx: gateCtx(root),
      runTests: async () => ({
        status: '❌',
        command: 'npm test',
        exitCode: 1,
        lastLine: 'FAIL',
        envBlocked: false,
      }),
    });

    strictEqual(r.testsStatus, '❌');
    strictEqual(r.testsNote.startsWith('❌'), true, r.testsNote);
    deepStrictEqual(readFileSync(testsPath, 'utf8').includes('Статус: ❌'), true);
  });

  it('гейт зелёный — testsStatus «✅»', async () => {
    const root = await repo();

    const r = await recordAttemptEvidence({
      projectRoot: root,
      diffPath: join(root, 'd.patch'),
      testsPath: join(root, 't.txt'),
      diffBefore: '',
      gateCtx: gateCtx(root),
      runTests: async () => ({ status: '✅', command: 'npm test', exitCode: 0, lastLine: 'ok', envBlocked: false }),
    });

    strictEqual(r.testsStatus, '✅');
  });
});
