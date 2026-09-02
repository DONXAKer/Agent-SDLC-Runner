import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runHiddenTests } from '../src/hiddenTests.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('runHiddenTests: реальные скрытые тесты oversize', () => {
  it('на нетронутой фикстуре: 2 регрессионных зелёных, точностные и human-кейсы красные', async () => {
    const r = await runHiddenTests({
      hiddenFile: 'bench/checks/hidden/oversize.hidden.mjs',
      targetDir: 'bench/fixture',
    });
    strictEqual(r.errorText, null);
    strictEqual(r.total, 9);
    const regression = r.cases.filter((c) => c.category === 'regression');
    strictEqual(regression.length, 2);
    ok(
      regression.every((c) => c.ok),
      'регрессионные кейсы зелёные на нетронутой фикстуре',
    );
    const human = r.cases.filter((c) => c.category === 'human');
    strictEqual(human.length, 3);
    ok(
      human.every((c) => !c.ok),
      'human-кейсы на нетронутой фикстуре красные — фичи ещё нет',
    );
  });
});

describe('runHiddenTests: разбор TAP на синтетическом файле', () => {
  it('пустая цель без строк TAP даёт errorText, а не тихий 0/0', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-hidden-')));
    roots.push(dir);
    const file = join(dir, 'empty.hidden.mjs');
    writeFileSync(file, 'export {};\n', 'utf8');
    const r = await runHiddenTests({ hiddenFile: file, targetDir: dir });
    strictEqual(r.total, 0);
    ok(r.errorText !== null);
  });

  it('кейс, пропущенный самим тестом (# SKIP), не зелёный и не в знаменателе', async () => {
    // Кейсы «дерево не тронуто» пропускают себя на цели без `.git` — TAP пишет их `ok … # SKIP`,
    // и без отдельного разбора они красили бы щуп точности правки в зелёный там, где проверки не было.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-hidden-')));
    roots.push(dir);
    const file = join(dir, 'skip.hidden.mjs');
    writeFileSync(
      file,
      [
        "import { test } from 'node:test';",
        "test('R1 [regression]: есть', () => {});",
        "test('Pr1 [precision]: дерево не тронуто', (t) => { t.skip('цели без .git'); });",
        "test('Pr2 [precision]: падает', () => { throw new Error('нет'); });",
        '',
      ].join('\n'),
      'utf8',
    );
    const r = await runHiddenTests({ hiddenFile: file, targetDir: dir });
    strictEqual(r.errorText, null);
    strictEqual(r.cases.length, 3);
    strictEqual(r.skipped, 1);
    strictEqual(r.total, 2);
    strictEqual(r.pass, 1);
    strictEqual(r.fail, 1);
    const pr1 = r.cases.find((c) => c.id === 'Pr1')!;
    strictEqual(pr1.skipped, true);
    strictEqual(pr1.ok, false);
  });

  it('# TODO — тоже пропуск, в обе стороны', async () => {
    // `t.todo()` на падающем тесте даёт `not ok … # TODO` и код 0: без разбора директивы
    // «ok # TODO» зеленел, «not ok # TODO» считался провалом. Оба — «не считать».
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-hidden-')));
    roots.push(dir);
    const file = join(dir, 'todo.hidden.mjs');
    writeFileSync(
      file,
      [
        "import { test } from 'node:test';",
        "test('Pr1 [precision]: позже', { todo: true }, () => {});",
        "test('Pr2 [precision]: падает, но todo', { todo: 'потом' }, () => { throw new Error('нет'); });",
        "test('R1 [regression]: есть', () => {});",
        '',
      ].join('\n'),
      'utf8',
    );
    const r = await runHiddenTests({ hiddenFile: file, targetDir: dir });
    strictEqual(r.skipped, 2);
    strictEqual(r.total, 1);
    strictEqual(r.pass, 1);
  });

  it('крах до единого кейса: причина из stdout попадает в errorText', async () => {
    // node --test пишет ERR_MODULE_NOT_FOUND в stdout строками `# …`, stderr пуст — «stderr: »
    // в отчёте ничего не объяснял.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-hidden-')));
    roots.push(dir);
    const file = join(dir, 'broken.hidden.mjs');
    writeFileSync(file, "import './нет-такого-модуля.mjs';\n", 'utf8');
    const r = await runHiddenTests({ hiddenFile: file, targetDir: dir });
    strictEqual(r.total, 0);
    ok(r.errorText !== null && /нет-такого-модуля|ERR_MODULE_NOT_FOUND/u.test(r.errorText), r.errorText ?? '');
  });

  it('несуществующий файл — errorText от spawn, не исключение наружу', async () => {
    const r = await runHiddenTests({ hiddenFile: '/нет/такого/файла.mjs', targetDir: '.' });
    strictEqual(r.total, 0);
    strictEqual(r.pass, 0);
  });
});
