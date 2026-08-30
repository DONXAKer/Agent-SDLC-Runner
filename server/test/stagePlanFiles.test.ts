/**
 * Авто-`git add` новых файлов из `files_to_touch` одобренного плана.
 *
 * Сторожится: в индекс заводятся ТОЛЬКО файлы, названные планом (право на них уже выдано
 * одобрением плана); нетракованный файл вне плана остаётся нетракованным — его обязан
 * назвать гейт «Scope: нетракованные файлы», и ослаблять этот гейт нельзя.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { git, stageNewPlanFiles } from '../src/gates/git.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-stage-'));
  roots.push(root);
  await git(['init'], root);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'база'], root);
  return root;
}

async function staged(root: string): Promise<string[]> {
  const r = await git(['diff', '--cached', '--name-only'], root);
  return r.stdout.split('\n').filter((l) => l.trim() !== '');
}

describe('авто-заведение новых файлов плана в git', () => {
  it('файл из плана заводится, файл вне плана остаётся нетракованным', async () => {
    const root = await repo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'oversize.ts'), 'export {};\n');
    writeFileSync(join(root, 'notes.txt'), 'вне плана\n');

    const added = await stageNewPlanFiles(root, ['src/oversize.ts']);

    deepStrictEqual(added, ['src/oversize.ts']);
    deepStrictEqual(await staged(root), ['src/oversize.ts']);
    const untracked = await git(['ls-files', '--others', '--exclude-standard'], root);
    ok(untracked.stdout.includes('notes.txt'), 'файл вне плана обязан остаться нетракованным');
  });

  it('нечего заводить — пустой список, индекс не тронут', async () => {
    const root = await repo();
    writeFileSync(join(root, 'notes.txt'), 'вне плана\n');
    deepStrictEqual(await stageNewPlanFiles(root, ['src/oversize.ts']), []);
    deepStrictEqual(await staged(root), []);
  });

  it('пустой план — ничего не делает, git не зовётся зря', async () => {
    const root = await repo();
    writeFileSync(join(root, 'a.txt'), 'x\n');
    deepStrictEqual(await stageNewPlanFiles(root, []), []);
  });

  it('уже отслеживаемый файл плана не трогается: заводятся только новые', async () => {
    const root = await repo();
    writeFileSync(join(root, 'known.ts'), 'старый\n');
    await git(['add', 'known.ts'], root);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'known'], root);
    writeFileSync(join(root, 'known.ts'), 'правка\n');

    deepStrictEqual(await stageNewPlanFiles(root, ['known.ts']), []);
    strictEqual((await staged(root)).length, 0, 'правка отслеживаемого файла не должна попадать в индекс');
  });
});
