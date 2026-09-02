/**
 * Скрытые тесты семейства legacy-docs — общий интерпретатор эталона.
 *
 * Обе задачи семейства — с НУЛЕВЫМ изменением кода: `docs-sync` правит README и комментарии,
 * `characterization` пишет новые тесты. Поэтому поведенческие кейсы (`call`) здесь зелёные на
 * пристинной по дизайну — они сторожат, что код не тронут, — а сигнал задачи несут кейсы про
 * текст файлов и про набор тестов цели.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect` — прямой вызов функции из index.ts цели; примитив
 *    сверяется строго, объект и массив — глубоко (aggregate возвращает массив записей);
 *  - `file: путь` + `mustContain` / `mustNotContain` — файловый кейс (lib/fileCases.mjs):
 *    элемент — дословная подстрока либо `{ regex, flags? }`; путь — относительно цели;
 *  - `newTestFile: { dir, exclude: [имена] }` + `expect: { atLeast: N }` — в каталоге цели
 *    появилось не меньше N файлов `*.test.ts`, не считая перечисленных (существующих в
 *    пристинной); имя нового файла не угадывается — считается любой;
 *  - `suite: {}` + `expect: { allGreen?: true, testsAbove?: N }` — набор тестов цели, прогнанный
 *    дочерним процессом (lib/spawnTests.mjs), зелёный и/или содержит строго больше N кейсов
 *    (N — счёт пристинной, записан в эталоне руками).
 *
 * Живёт в `lib/` без суффикса `.hidden.mjs`: файл с суффиксом читается как тест задачи, а
 * этот без BENCH_EXPECTED_SLUG падает. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertFileCase } from './fileCases.mjs';
import { runTargetTests } from './spawnTests.mjs';
import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}

const TARGET = targetDir('legacy-docs');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET);

/** Новые тестовые файлы каталога: всё `*.test.ts`, кроме перечисленных как существующие. */
function newTestFiles(target, spec) {
  const dir = join(target, spec.dir);
  if (!existsSync(dir)) return [];
  const exclude = new Set(spec.exclude ?? []);
  return readdirSync(dir).filter((name) => name.endsWith('.test.ts') && !exclude.has(name));
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), async () => {
      if (c.call !== undefined) {
        const got = exportOf(mod, c.call.fn)(...c.call.args);
        if (got !== null && typeof got === 'object') deepStrictEqual(got, c.expect);
        else strictEqual(got, c.expect);
        return;
      }

      if (c.file !== undefined) {
        assertFileCase(TARGET, c);
        return;
      }

      if (c.newTestFile !== undefined) {
        const found = newTestFiles(TARGET, c.newTestFile);
        ok(
          found.length >= c.expect.atLeast,
          `в ${c.newTestFile.dir}/ цели ${found.length} новых *.test.ts (нужно не меньше ${c.expect.atLeast}); ` +
            `не считаются: ${(c.newTestFile.exclude ?? []).join(', ') || '—'}`,
        );
        return;
      }

      if (c.suite !== undefined) {
        const r = await runTargetTests(TARGET);
        const run = r.runs[0];
        if (c.expect.allGreen === true) {
          ok(r.allGreen, `набор тестов цели не зелёный: код ${run.exitCode}, pass ${run.pass}, fail ${run.fail}\n${run.stderr.slice(0, 1500)}`);
        }
        if (c.expect.testsAbove !== undefined) {
          ok(
            run.tests > c.expect.testsAbove,
            `в наборе цели ${run.tests} кейсов — новых тестов не появилось (в пристинной ${c.expect.testsAbove})`,
          );
        }
        return;
      }

      throw new Error(`кейс ${c.id}: неизвестная форма — нет ни call, ни file, ни newTestFile, ни suite`);
    });
  }
});
