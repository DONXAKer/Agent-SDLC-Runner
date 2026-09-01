import { ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      task: 'oversize',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'demo', expectedTask: 'oversize' });
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
      task: 'oversize',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'bench-local-qwen', expectedTask: 'oversize' });
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
      task: 'oversize',
    });
    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'demo',
      slug: 'second',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'chunk',
      task: 'oversize',
    });

    const restored = restoreSnapshot({ snapshotsDir, name: 'demo', targetSlug: 'second', expectedTask: 'oversize' });
    roots.push(restored.root);
    strictEqual(restored.slug, 'second');
    strictEqual(restored.stoppedAfterStage, 'chunk');
    restored.dispose();
  });

  it('лента событий прошлого прогона в снимок не попадает', async () => {
    // Иначе каждый прогон со снимка дописывает свои события в ЧУЖОЙ файл, а
    // `readPersistedEvents` фильтра по прогону не имеет: щупы получают смесь двух
    // прогонов. Бьёт в сторону ложного зелёного — щуп честности подтверждает утверждение
    // журнала успешным вызовом bash из ленты, и вызов предыдущего прогона годится ему
    // так же, как свой. Тот же класс, что протечка snapshot.json (r18).
    const workspaceRoot = await makeWorkspace();
    writeFileSync(
      join(workspaceRoot, '.sdlc', 'demo', '.events.ndjson'),
      '{"type":"tool_result","ok":true,"summary":"bash прошлого прогона"}\n',
      'utf8',
    );
    const snapshotsDir = tmp('sdlc-bench-snap-dir-');
    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'слот',
      slug: 'demo',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'plan',
      task: 'oversize',
    });

    strictEqual(existsSync(join(snapshotsDir, 'слот', '.sdlc', 'demo', '.events.ndjson')), false);

    const restored = restoreSnapshot({ snapshotsDir, name: 'слот', targetSlug: 'demo', expectedTask: 'oversize' });
    roots.push(restored.root);
    strictEqual(existsSync(join(restored.root, '.sdlc', 'demo', '.events.ndjson')), false);
    // Артефакты витка при этом на месте — чистится ровно лента, а не каталог.
    ok(existsSync(join(restored.root, '.sdlc', 'demo', 'plan.md')));
  });

  it('лента чистится и у снимков, снятых до этой правки', async () => {
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snap-dir-');
    makeSnapshot({
      workspaceRoot,
      snapshotsDir,
      name: 'старый',
      slug: 'demo',
      branch: 'sdlc/demo',
      stoppedAfterStage: 'plan',
      task: 'oversize',
    });
    // Имитируем прежний снимок: лента лежит внутри него.
    writeFileSync(join(snapshotsDir, 'старый', '.sdlc', 'demo', '.events.ndjson'), '{"type":"usage"}\n', 'utf8');

    const restored = restoreSnapshot({ snapshotsDir, name: 'старый', targetSlug: 'новый-слаг', expectedTask: 'oversize' });
    roots.push(restored.root);
    strictEqual(existsSync(join(restored.root, '.sdlc', 'новый-слаг', '.events.ndjson')), false);
    ok(existsSync(join(restored.root, '.sdlc', 'новый-слаг', 'plan.md')));
  });

  it('несуществующий снимок — понятная ошибка, а не ENOENT из fs', () => {
    const snapshotsDir = tmp('sdlc-bench-snaps-empty-');
    throws(() => restoreSnapshot({ snapshotsDir, name: 'нет-такого', targetSlug: 'x', expectedTask: 'oversize' }), SnapshotError);
  });

  it('каталог без snapshot.json — не считается снимком бенчмарка', () => {
    const snapshotsDir = tmp('sdlc-bench-snaps-foreign-');
    mkdirSync(join(snapshotsDir, 'чужое'), { recursive: true });
    writeFileSync(join(snapshotsDir, 'чужое', 'x.txt'), 'x', 'utf8');
    throws(() => restoreSnapshot({ snapshotsDir, name: 'чужое', targetSlug: 'x', expectedTask: 'oversize' }), SnapshotError);
  });

  it('verifyRestoredBranch падает понятной ошибкой на расхождении ветки', async () => {
    const workspaceRoot = await makeWorkspace();
    await rejects(verifyRestoredBranch(workspaceRoot, 'sdlc/другая-ветка'), SnapshotError);
  });

  it('снимок чужой задачи отвергается до копирования дерева', async () => {
    // Умолчание `--task oversize` делало это поведением по умолчанию: снимок billing под
    // oversize давал чужой банк ответов и чужие скрытые тесты поверх дерева — все кейсы
    // красные при исправной модели.
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snaps-');
    makeSnapshot({ workspaceRoot, snapshotsDir, name: 'vat', slug: 'demo', branch: 'sdlc/demo', stoppedAfterStage: 'plan', task: 'vat-rounding' });
    throws(
      () => restoreSnapshot({ snapshotsDir, name: 'vat', targetSlug: 'x', expectedTask: 'oversize' }),
      (e: unknown) => e instanceof SnapshotError && /vat-rounding/.test(e.message) && /oversize/.test(e.message),
    );
    const ok2 = restoreSnapshot({ snapshotsDir, name: 'vat', targetSlug: 'x', expectedTask: 'vat-rounding' });
    roots.push(ok2.root);
    strictEqual(ok2.taskUnverified, false);
    ok2.dispose();
  });

  it('снимок без поля task (снят до его появления) принимается с пометкой, а не ошибкой', async () => {
    // `oversize-plan`/`freeship-plan` — оплаченные прогоны на claude-sdk; ломать их
    // ради нового поля нельзя.
    const workspaceRoot = await makeWorkspace();
    const snapshotsDir = tmp('sdlc-bench-snaps-');
    makeSnapshot({ workspaceRoot, snapshotsDir, name: 'старый', slug: 'demo', branch: 'sdlc/demo', stoppedAfterStage: 'plan', task: 'oversize' });
    const metaFile = join(snapshotsDir, 'старый', 'snapshot.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    delete meta['task'];
    writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    const restored = restoreSnapshot({ snapshotsDir, name: 'старый', targetSlug: 'x', expectedTask: 'freeship' });
    roots.push(restored.root);
    strictEqual(restored.taskUnverified, true);
    restored.dispose();
  });
});
