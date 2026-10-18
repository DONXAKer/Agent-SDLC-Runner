/**
 * `refreshAttemptEvidence` — root-cause 2026-09-27/28 (`docs/model-runs.md`): посев на
 * `--from-snapshot` правит файл фикстуры В ДЕРЕВЕ, а рецензент и встроенные гейты читают
 * ПАТЧ, снятый снимком ДО посева. Без перегенерации посев рецензенту не виден вовсе.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { git } from '../../server/src/gates/git.ts';
import { WitokPaths } from '../../server/src/artifacts/paths.ts';
import { recordAttemptEvidence } from '../../server/src/run/evidence.ts';
import type { AttemptEvidence } from '../../server/src/run/evidence.ts';
import { SeedEvidenceError, refreshAttemptEvidence } from '../src/seedEvidence.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-seedevidence-'));
  roots.push(root);
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'sdlc@test'], root);
  await git(['config', 'user.name', 'sdlc'], root);
  await git(['config', 'core.autocrlf', 'false'], root);
  return root;
}

async function commitAll(root: string, msg: string): Promise<string> {
  await git(['add', '-A'], root);
  await git(['commit', '-q', '-m', msg], root);
  return (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
}

function readEvidence(path: string): AttemptEvidence {
  return JSON.parse(readFileSync(path, 'utf8')) as AttemptEvidence;
}

describe('refreshAttemptEvidence', () => {
  it('перегенерирует патч и diff_sha256 под дерево С применённым посевом', async () => {
    const root = await repo();
    writeFileSync(join(root, 'src.ts'), 'export const x = 1;\n', 'utf8');
    const base = await commitAll(root, 'база — конец chunk (как снял снимок)');
    const paths = new WitokPaths(root, 'axes-snap');
    mkdirSync(paths.dir, { recursive: true });
    const r = await recordAttemptEvidence({
      projectRoot: root,
      diffPath: paths.chunkDiff(1, 1),
      testsPath: paths.chunkTests(1, 1),
      evidencePath: paths.chunkEvidence(1, 1),
      diffBefore: '',
      baseSha: base,
      gateCtx: { projectRoot: root, planFiles: [], baseline: null, timeoutMs: 5000 },
      runTests: null,
      meta: { slug: 'axes-snap', chunk: 1, attempt: 1, executorModel: 'sonnet' },
    });
    // Патч снят на дереве ДО посева — пустой (dev-снимок chunk не менял файл в этом тесте).
    strictEqual(r.evidence.diff_empty, true);
    const diffBeforeSeed = readFileSync(paths.chunkDiff(1, 1), 'utf8');

    // Посев — как applySeed: правит файл фикстуры В ДЕРЕВЕ, патч снимка об этом не знает.
    writeFileSync(join(root, 'src.ts'), 'export const x = 1;\nconsole.log(process.env.SECRET);\n', 'utf8');

    await refreshAttemptEvidence(root, 'axes-snap');

    const diffAfter = readFileSync(paths.chunkDiff(1, 1), 'utf8');
    strictEqual(diffAfter === diffBeforeSeed, false, 'патч обязан измениться — посев внесён в дерево');
    strictEqual(diffAfter.includes('SECRET'), true, 'рецензент теперь видит посеянную строку в патче');

    const evidence = readEvidence(paths.chunkEvidence(1, 1));
    strictEqual(evidence.diff_empty, false);
    strictEqual(evidence.diff_sha256 !== r.evidence.diff_sha256, true, 'хэш патча обязан обновиться вместе с патчем');
    deepStrictEqual(evidence.diffstat.paths, ['src.ts']);
    // Улики теста НЕ трогаются — посев `expected: 'review'` тестов фикстуры не касается.
    strictEqual(evidence.tests_sha256, r.evidence.tests_sha256);
    strictEqual(evidence.base_sha, base, 'база не меняется — патч снят от той же базы, что и снимком');
  });

  it('нет ни одной evidence.json в каталоге витка — понятная ошибка, а не молчаливый пропуск', async () => {
    const root = await repo();
    await commitAll(root, 'пусто');
    await new Promise<void>((resolve, reject) => {
      refreshAttemptEvidence(root, 'no-such-witok').then(
        () => reject(new Error('ожидалась SeedEvidenceError')),
        (e: unknown) => {
          if (e instanceof SeedEvidenceError && /снимок снят до появления/.test(e.message)) resolve();
          else reject(e);
        },
      );
    });
  });

  it('evidence.json есть, но патча попытки нет на диске — понятная ошибка', async () => {
    const root = await repo();
    await commitAll(root, 'пусто');
    const paths = new WitokPaths(root, 'axes-snap');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.chunkEvidence(1, 1), '{}', 'utf8');
    strictEqual(existsSync(paths.chunkDiff(1, 1)), false);

    await new Promise<void>((resolve, reject) => {
      refreshAttemptEvidence(root, 'axes-snap').then(
        () => reject(new Error('ожидалась SeedEvidenceError')),
        (e: unknown) => {
          if (e instanceof SeedEvidenceError && /патча попытки нет/.test(e.message)) resolve();
          else reject(e);
        },
      );
    });
  });
});
