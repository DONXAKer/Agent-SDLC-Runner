/**
 * Помощники скрытых тестов `bench/checks/hidden/lib/` — герметично, на временных каталогах.
 *
 * Сами скрытые тесты в `bench:test` не гоняются (у них цель — дерево после chunk'а), поэтому
 * их общие механики проверяются здесь: иначе ошибка в спавне набора тестов цели всплыла бы
 * только на платном прогоне, и выглядела бы как «модель не починила тест».
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { git } from '../../server/src/gates/git.ts';
import { assertFileCase, fileCaseProblems } from '../checks/hidden/lib/fileCases.mjs';
import { diffStat, gitAvailable, porcelain } from '../checks/hidden/lib/gitState.mjs';
import { runTargetTests } from '../checks/hidden/lib/spawnTests.mjs';
import { caseLabel, readExpected, targetDir } from '../checks/hidden/lib/target.mjs';

const roots: string[] = [];
function tmp(prefix: string): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(r);
  return r;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('lib/target', () => {
  it('цель — BENCH_TARGET_DIR, без неё пристинная фикстура семейства', () => {
    const prev = process.env.BENCH_TARGET_DIR;
    try {
      delete process.env.BENCH_TARGET_DIR;
      ok(targetDir('billing').replace(/\\/g, '/').endsWith('bench/fixtures/billing'));
      process.env.BENCH_TARGET_DIR = 'X:/цель';
      strictEqual(targetDir('billing'), 'X:/цель');
    } finally {
      if (prev === undefined) delete process.env.BENCH_TARGET_DIR;
      else process.env.BENCH_TARGET_DIR = prev;
    }
  });

  it('эталон читается по слагу, подпись кейса разбирается hiddenTests.ts', () => {
    const e = readExpected('oversize');
    ok(e.cases.length >= 9);
    strictEqual(caseLabel({ id: 'Pr2', category: 'precision', claim: 'claim-3', description: 'т' }), 'Pr2 [precision] (claim-3): т');
    strictEqual(caseLabel({ id: 'R1', category: 'regression', claim: null, description: 'т' }), 'R1 [regression]: т');
  });
});

describe('lib/spawnTests', () => {
  function project(testBody: string): string {
    const root = tmp('sdlc-hiddenlib-tests-');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'a.test.ts'), testBody, 'utf8');
    return root;
  }

  it('зелёный набор цели: tests/pass из сводки TAP, allGreen', async () => {
    const root = project("import { test } from 'node:test';\ntest('раз', () => {});\ntest('два', () => {});\n");
    const r = await runTargetTests(root);
    strictEqual(r.runs.length, 1);
    strictEqual(r.runs[0]!.tests, 2);
    strictEqual(r.runs[0]!.pass, 2);
    strictEqual(r.runs[0]!.fail, 0);
    strictEqual(r.allGreen, true);
  });

  it('красный набор: fail считается, allGreen ложь; несколько прогонов подряд', async () => {
    const root = project("import { test } from 'node:test';\ntest('падает', () => { throw new Error('нет'); });\n");
    const r = await runTargetTests(root, { times: 3 });
    strictEqual(r.runs.length, 3);
    strictEqual(r.runs[0]!.fail, 1);
    strictEqual(r.greenRuns, 0);
    strictEqual(r.allGreen, false);
  });

  it('набор без единого теста не считается зелёным', async () => {
    const root = tmp('sdlc-hiddenlib-empty-');
    mkdirSync(join(root, 'test'));
    const r = await runTargetTests(root);
    strictEqual(r.allGreen, false);
  });

  it('падающий тест под todo не делает набор зелёным', async () => {
    // Иначе «починить» неверный ассерт (broken-test) можно было бы, пометив его todo:
    // node даёт код 0 и `# fail 0`.
    const root = project("import { test } from 'node:test';\ntest('ок', () => {});\ntest('спрятан', { todo: true }, () => { throw new Error('нет'); });\n");
    const r = await runTargetTests(root);
    strictEqual(r.runs[0]!.exitCode, 0);
    strictEqual(r.runs[0]!.fail, 0);
    strictEqual(r.runs[0]!.todo, 1);
    strictEqual(r.allGreen, false);
  });
});

describe('lib/gitState', () => {
  it('без .git — недоступно; с репозиторием — porcelain/diffStat видят правки', async () => {
    const root = tmp('sdlc-hiddenlib-git-');
    strictEqual(gitAvailable(root), false);

    await git(['init', '--initial-branch=main'], root);
    await git(['config', 'user.name', 'т'], root);
    await git(['config', 'user.email', 't@example.invalid'], root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await git(['add', '-A'], root);
    await git(['commit', '-m', 'init'], root);

    strictEqual(gitAvailable(root), true);
    strictEqual(porcelain(root, ['src/']), '');
    strictEqual(diffStat(root, ['src/']), '');

    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
    ok(porcelain(root, ['src/']).includes('a.ts'), 'изменённый файл виден');
    ok(porcelain(root, ['src/']).includes('b.ts'), 'untracked файл тоже виден — это не «нетронуто»');
    ok(diffStat(root, ['src/']).includes('a.ts'));
    strictEqual(porcelain(root, ['test/']), '', 'по чужому пути — чисто');
    // Без путей git видит всё дерево, а рабочая копия витка никогда не чиста (untracked .sdlc/).
    let threw = false;
    try {
      porcelain(root, []);
    } catch {
      threw = true;
    }
    strictEqual(threw, true, 'porcelain без путей обязан отказать');
  });
});

describe('lib/fileCases', () => {
  it('подстроки и регулярки; отсутствующий файл — провал с текстом, не ENOENT', () => {
    const root = tmp('sdlc-hiddenlib-files-');
    writeFileSync(join(root, 'README.md'), '# Отчёт\nСортировка по убыванию. Порог включающий.\n', 'utf8');

    deepStrictEqual(
      fileCaseProblems(root, {
        file: 'README.md',
        mustContain: ['по убыванию', { regex: 'порог\\s+включ', flags: 'iu' }],
        mustNotContain: ['по возрастанию'],
      }),
      [],
    );
    const problems = fileCaseProblems(root, {
      file: 'README.md',
      mustContain: ['по возрастанию'],
      mustNotContain: [{ regex: 'убыван' }],
    });
    strictEqual(problems.length, 2);
    deepStrictEqual(fileCaseProblems(root, { file: 'нет.md', mustContain: ['x'] }), ['файла нет.md в цели нет']);
    mkdirSync(join(root, 'docs'));
    strictEqual(fileCaseProblems(root, { file: 'docs', mustContain: ['x'] }).length, 1, 'каталог — не файл, а не EISDIR');
    strictEqual(fileCaseProblems(root, { file: join(root, 'README.md'), mustContain: ['x'] }).length, 1, 'абсолютный путь отвергается');
    let threw = false;
    try {
      assertFileCase(root, { file: 'README.md', mustNotContain: ['Отчёт'] });
    } catch {
      threw = true;
    }
    strictEqual(threw, true);
  });
});
