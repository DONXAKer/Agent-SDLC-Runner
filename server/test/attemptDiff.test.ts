/**
 * `attemptDiff` — патч попытки тем же способом, что `attempt-evidence.py` методологии:
 * от базы плана, полный контекст, без `--ignore-cr-at-eol`, нетракованные через
 * `--no-index` против `/dev/null`, без `.sdlc/**` и кэш-мусора — и применимый `git apply`
 * к дереву на базе.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { attemptDiff, git, isJunkPath } from '../src/gates/git.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-adiff-'));
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

describe('attemptDiff', () => {
  it('от базы плана, а не от HEAD; нетракованные и удалённые входят; .sdlc и мусор — нет', async () => {
    const root = await repo();
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
    writeFileSync(join(root, 'gone.txt'), 'bye\n', 'utf8');
    const base = await commitAll(root, 'base');
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    await commitAll(root, 'moved head');
    writeFileSync(join(root, 'new.txt'), 'fresh\n', 'utf8');
    rmSync(join(root, 'gone.txt'));
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), '# план\n', 'utf8');
    mkdirSync(join(root, '__pycache__'), { recursive: true });
    writeFileSync(join(root, '__pycache__', 'x.pyc'), 'junk', 'utf8');

    const patch = await attemptDiff(root, { baseSha: base });

    ok(patch.includes('+three'), 'правка после базы (в HEAD) видна от базы');
    ok(patch.includes('--- /dev/null\n+++ b/new.txt'), `нетракованный как добавленный:\n${patch}`);
    ok(patch.includes('+++ /dev/null'), 'удалённый как удалённый');
    ok(!patch.includes('plan.md'), 'артефакты витка исключены');
    ok(!patch.includes('x.pyc'), 'кэш-мусор исключён');
    ok(!patch.includes('[рантайм]'), 'в патч не дописывается ничего');
  });

  it('CRLF сохраняется байт в байт и патч применим к дереву на базе', async () => {
    const root = await repo();
    writeFileSync(join(root, 'win.txt'), Buffer.from('a\r\nb\r\n', 'utf8'));
    const base = await commitAll(root, 'base');
    writeFileSync(join(root, 'win.txt'), Buffer.from('a\r\nb\r\nc\r\n', 'utf8'));
    writeFileSync(join(root, 'new.txt'), 'x\n', 'utf8');

    const patch = await attemptDiff(root, { baseSha: base });
    ok(patch.includes('+c\r\n'), 'CR в добавленной строке на месте');

    // Применимость проверяется на дереве базы — отдельный worktree, не stash.
    const wt = mkdtempSync(join(tmpdir(), 'sdlc-adiff-wt-'));
    roots.push(wt);
    rmSync(wt, { recursive: true, force: true });
    const add = await git(['worktree', 'add', '-q', wt, base], root);
    strictEqual(add.code, 0, add.stderr);
    const patchPath = join(root, 'p.patch');
    writeFileSync(patchPath, Buffer.from(patch, 'utf8'));
    const check = await git(['apply', '--check', patchPath], wt);
    strictEqual(check.code, 0, check.stderr);
    await git(['worktree', 'remove', '--force', wt], root);
  });

  it('репозиторий без коммитов — от индекса; не репозиторий — пусто; плохая база — исключение', async () => {
    const root = await repo();
    writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
    const fresh = await attemptDiff(root, { baseSha: null });
    ok(fresh.includes('+++ b/a.txt'), fresh);

    const plain = mkdtempSync(join(tmpdir(), 'sdlc-adiff-plain-'));
    roots.push(plain);
    strictEqual(await attemptDiff(plain, { baseSha: null }), '');

    await commitAll(root, 'base');
    let failed = false;
    try {
      await attemptDiff(root, { baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    } catch {
      failed = true;
    }
    ok(failed, 'несуществующая база — исключение, а не пустой патч');
  });

  it('перегенерация даёт тот же текст — основа сверки этапа 6', async () => {
    const root = await repo();
    writeFileSync(join(root, 'a.txt'), 'one\n', 'utf8');
    const base = await commitAll(root, 'base');
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
    const first = await attemptDiff(root, { baseSha: base });
    const second = await attemptDiff(root, { baseSha: base });
    strictEqual(first, second);
    strictEqual(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  });
});

describe('isJunkPath', () => {
  it('кэш-каталоги и .pyc — мусор, обычные пути — нет', () => {
    strictEqual(isJunkPath('__pycache__/m.cpython-312.pyc'), true);
    strictEqual(isJunkPath('src/node_modules/x/index.js'), true);
    strictEqual(isJunkPath('.DS_Store'), true);
    strictEqual(isJunkPath('src/main.py'), false);
    strictEqual(isJunkPath('tests/test_x.py'), false);
  });
});
