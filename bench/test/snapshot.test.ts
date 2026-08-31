import { ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { git } from '../../server/src/gates/git.ts';
import { SnapshotError, makeSnapshot, restoreSnapshot, verifyRestoredBranch } from '../src/snapshot.ts';

const roots: string[] = [];
function tmp(prefix: string): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(r);
  return r;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const root = tmp('sdlc-bench-snap-src-');
  await git(['init', '--initial-branch=main'], root);
  await git(['config', 'user.name', 'т'], root);
  await git(['config', 'user.email', 't@example.invalid'], root);
  writeFileSync(join(root, 'a.txt'), 'привет\n', 'utf8');
  await git(['add', '-A'], root);
  await git(['commit', '-m', 'init'], root);
  await git(['checkout', '-b', 'sdlc/demo'], root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), '# План\nодобрен\n', 'utf8');
  return root;
}

describe('makeSnapshot / restoreSnapshot', () => {
  it('снимок восстанавливается с тем же деревом и веткой', async () => {
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snaps-');

    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'demo',
      slug: 'demo',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'plan',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'demo' });
    roots.push(restored.root);

    strictEqual(restored.slug, 'demo');
    strictEqual(restored.branch, 'sdlc/demo');
    strictEqual(restored.stoppedAfterStage, 'plan');

    await verifyRestoredBranch(restored.root, 'sdlc/demo');

    const planPath = join(restored.root, '.sdlc', 'demo', 'plan.md');
    ok(planPath, 'путь собран');

    // Метафайл бенчмарка в рабочей копии — untracked-файл в корне ЦЕЛЕВОГО проекта:
    // он ронял scope-гейты на каждом прогоне со снимка (r18).
    strictEqual(existsSync(join(restored.root, 'snapshot.json')), false, 'snapshot.json утёк в рабочую копию');
    ok(existsSync(join(snapshotsDir, 'demo', 'snapshot.json')), 'в самом снимке метафайл обязан остаться');
    restored.dispose();
  });

  it('слаг нового прогона отличается от слага снимка — каталог артефактов переименовывается', async () => {
    // Регрессия: артефакты снимка лежат под `.sdlc/<исходный слаг>/` (`WitokPaths`), и
    // прогон с ДРУГИМ `--slug` искал бы `plan.md` там, где его нет — поймано первым же
    // живым прогоном со снимка: chunk «провалился» блокером «нет файла», не дойдя до
    // модели ни разу, и выглядел неотличимо от честного результата.
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snaps-rename-');

    // `makeWorkspace()` кладёт артефакты под `.sdlc/demo/` — слаг снимка обязан совпасть
    // с реальным каталогом на диске, иначе тест проверял бы собственную опечатку.
    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'demo',
      slug: 'demo',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'plan',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'bench-local-qwen' });
    roots.push(restored.root);

    strictEqual(restored.slug, 'bench-local-qwen');
    ok(existsSync(join(restored.root, '.sdlc', 'bench-local-qwen', 'plan.md')), 'план виден под новым слагом');
    ok(!existsSync(join(restored.root, '.sdlc', 'demo')), 'старый каталог слага не остался рядом');
    restored.dispose();
  });

  it('повторный снимок под тем же именем заменяет прежний, а не копится рядом', async () => {
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snaps-');

    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'demo',
      slug: 'first',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'plan',
    });
    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'demo',
      slug: 'second',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'chunk',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'second' });
    roots.push(restored.root);
    strictEqual(restored.slug, 'second');
    strictEqual(restored.stoppedAfterStage, 'chunk');
    restored.dispose();
  });

  it('несуществующий снимок — понятная ошибка, а не ENOENT из fs', () => {
    const snapshotsDir = tmp('sdlc-bench-snaps-empty-');
    throws(() => restoreSnapshot({ snapshotsDir, name: 'нет-такого', targetSlug: 'x' }), SnapshotError);
  });

  it('каталог без snapshot.json — не считается снимком бенчмарка', () => {
    const snapshotsDir = tmp('sdlc-bench-snaps-foreign-');
    mkdirSync(join(snapshotsDir, 'чужое'), { recursive: true });
    writeFileSync(join(snapshotsDir, 'чужое', 'x.txt'), 'x', 'utf8');
    throws(() => restoreSnapshot({ snapshotsDir, name: 'чужое', targetSlug: 'x' }), SnapshotError);
  });

  it('verifyRestoredBranch падает понятной ошибкой на расхождении ветки', async () => {
    const workspaceRoot = await makeWorkspace();
    await rejects(verifyRestoredBranch(workspaceRoot, 'sdlc/другая-ветка'), SnapshotError);
  });
});
