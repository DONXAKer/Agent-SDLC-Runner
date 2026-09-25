/**
 * `recordAttemptEvidence` — свидетельства попытки производит рантайм: патч от базы, ПОЛНЫЙ
 * вывод тестов и запись `evidence.json` по контракту `attempt-evidence.py` методологии
 * (база, хэши, команда, код возврата, улика инструмента, diffstat, модель исполнителя).
 * Статус тестов — структурой (`testsStatus`), не только строкой (`testsNote`): второй разбор
 * строки регуляркой в `RunMetrics.chunkEvidence` рано или поздно разошёлся бы с текстом.
 */

import { createHash } from 'node:crypto';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { GateContext } from '../src/gates/builtin/index.ts';
import { git } from '../src/gates/git.ts';
import { recordAttemptEvidence } from '../src/run/evidence.ts';
import type { AttemptEvidence } from '../src/run/evidence.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** `attemptDiff` внутри читает git-дерево — голый временный каталог без репозитория. */
async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-evidence-'));
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

function gateCtx(projectRoot: string): GateContext {
  return { projectRoot, planFiles: [], baseline: null, timeoutMs: 5000 };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
}

function paths(root: string): { diffPath: string; testsPath: string; evidencePath: string } {
  return { diffPath: join(root, 'd.patch'), testsPath: join(root, 't.txt'), evidencePath: join(root, 'e.json') };
}

const meta = { slug: 'demo', chunk: 1, attempt: 1, executorModel: 'stub-model' };

function readEvidence(path: string): AttemptEvidence {
  return JSON.parse(readFileSync(path, 'utf8')) as AttemptEvidence;
}

describe('recordAttemptEvidence: testsStatus структурой', () => {
  it('гейт «Тесты» не в наборе — ⏭, файл-улика и evidence.json это говорят', async () => {
    const root = await repo();
    const p = paths(root);

    const r = await recordAttemptEvidence({
      projectRoot: root,
      ...p,
      diffBefore: '',
      baseSha: null,
      gateCtx: gateCtx(root),
      runTests: null,
      meta,
    });

    strictEqual(r.testsStatus, '⏭');
    strictEqual(r.tree, 'empty');
    strictEqual(readFileSync(p.testsPath, 'utf8').includes('гейт «Тесты» в наборе не найден'), true);
    const e = readEvidence(p.evidencePath);
    strictEqual(e.tool, 'sdlc-runner');
    strictEqual(e.tests_cmd, null);
    strictEqual(e.tests_status, '⏭');
    strictEqual(e.diff_empty, true);
    strictEqual(e.executor_model, 'stub-model');
    strictEqual(e.executor_model_source, 'факт рантайма: маршрут профиля');
  });

  it('гейт есть и красный — testsStatus совпадает с тем, что вернул сам гейт; вывод в улике полный', async () => {
    const root = await repo();
    const p = paths(root);
    const output = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');

    const r = await recordAttemptEvidence({
      projectRoot: root,
      ...p,
      diffBefore: '',
      baseSha: null,
      gateCtx: gateCtx(root),
      runTests: async () => ({
        status: '❌',
        command: 'npm test',
        exitCode: 1,
        lastLine: 'FAIL',
        envBlocked: false,
        outputTail: output.split('\n').slice(-200).join('\n'),
        output,
      }),
      meta,
    });

    strictEqual(r.testsStatus, '❌');
    strictEqual(r.testsNote.startsWith('❌'), true, r.testsNote);
    const text = readFileSync(p.testsPath, 'utf8');
    deepStrictEqual(text.includes('Статус: ❌'), true);
    ok(text.includes('line 0'), 'вывод записан целиком, а не хвостом');
    ok(text.includes('## Вывод команды (полный'), 'файл называет вывод полным');
    const e = readEvidence(p.evidencePath);
    strictEqual(e.tests_exit, 1);
    strictEqual(e.tests_cmd, 'npm test');
    strictEqual(e.missing_tool, null);
    strictEqual(e.tests_truncated, false);
    strictEqual(e.tests_sha256, sha256(p.testsPath), 'хэш записи о тестах — по файлу, как его сверит этап 6');
    strictEqual(e.diff_sha256, sha256(p.diffPath));
  });

  it('гейт зелёный — testsStatus «✅»', async () => {
    const root = await repo();

    const r = await recordAttemptEvidence({
      projectRoot: root,
      ...paths(root),
      diffBefore: '',
      baseSha: null,
      gateCtx: gateCtx(root),
      runTests: async () => ({ status: '✅', command: 'npm test', exitCode: 0, lastLine: 'ok', envBlocked: false }),
      meta,
    });

    strictEqual(r.testsStatus, '✅');
  });

  it('инструмента нет — улика оболочки уходит в missing_tool записи', async () => {
    const root = await repo();
    const p = paths(root);

    await recordAttemptEvidence({
      projectRoot: root,
      ...p,
      diffBefore: '',
      baseSha: null,
      gateCtx: gateCtx(root),
      runTests: async () => ({
        status: '⏭',
        command: './gradlew test',
        exitCode: 127,
        lastLine: 'инструмента нет в среде (код 127): bash: ./gradlew: No such file or directory',
        envBlocked: true,
        missingTool: 'bash: ./gradlew: No such file or directory',
      }),
      meta,
    });

    const e = readEvidence(p.evidencePath);
    strictEqual(e.missing_tool, 'bash: ./gradlew: No such file or directory');
    strictEqual(e.tests_status, '⏭');
  });
});

describe('recordAttemptEvidence: патч от базы плана и diffstat', () => {
  it('правка, новый и удалённый файлы — от base_sha, с diffstat по файлам и удалёнными отдельно', async () => {
    const root = await repo();
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
    writeFileSync(join(root, 'gone.txt'), 'bye\n', 'utf8');
    const base = await commitAll(root, 'base');
    // Второй коммит после базы: патч обязан считаться от базы плана, а не от HEAD.
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    await commitAll(root, 'after base');
    writeFileSync(join(root, 'new.txt'), 'fresh\n', 'utf8');
    rmSync(join(root, 'gone.txt'));
    const p = paths(root);

    const r = await recordAttemptEvidence({
      projectRoot: root,
      ...p,
      diffBefore: '',
      baseSha: base,
      gateCtx: gateCtx(root),
      runTests: null,
      meta,
    });

    strictEqual(r.tree, 'changed');
    const e = readEvidence(p.evidencePath);
    strictEqual(e.base_sha, base);
    strictEqual(e.diff_empty, false);
    deepStrictEqual(e.diffstat.paths, ['a.txt', 'gone.txt', 'new.txt']);
    deepStrictEqual(e.diffstat.deleted_paths, ['gone.txt']);
    deepStrictEqual(e.diffstat.per_file['new.txt'], { added: 1, deleted: 0, new: true, deleted_entirely: false });
    deepStrictEqual(e.diffstat.per_file['a.txt'], { added: 1, deleted: 0, new: false, deleted_entirely: false });
    strictEqual(e.diffstat.files, 3);
    // Патч — байты git: без шапки рантайма и без переводов строк.
    const patch = readFileSync(p.diffPath, 'utf8');
    ok(patch.startsWith('diff --git '), patch.slice(0, 40));
    ok(patch.includes('+++ /dev/null'), 'удаление видно как +++ /dev/null');
    ok(patch.includes('--- /dev/null'), 'новый файл видно как --- /dev/null');
  });
});
