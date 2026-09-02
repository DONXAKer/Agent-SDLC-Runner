/**
 * Скрытые тесты задачи broken-test (семейство broken-assert).
 *
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test broken-test.hidden.mjs`; без переменной цель —
 * пристинная фикстура. Пристинная здесь КРАСНАЯ по дизайну — набор падает на одном неверном
 * ассерте, это и есть задача, — поэтому на ней: regression (R1–R3) зелёные, Pr1 (набор
 * зелёный) и H1 (ожидание исправлено) красные, Pr2 (src/ не тронут) пропускается без `.git`.
 *
 * Формат кейсов `bench/expected/broken-test.json`:
 *  - `call: { fn, args }` + `expect: число` — прямой вызов функции из index.ts цели;
 *  - `suite: {}` + `expect: { allGreen, testsAtLeast }` — набор тестов цели гоняется дочерним
 *    процессом (lib/spawnTests.mjs): зелёный целиком и не короче пристинного — удалить
 *    падающий кейс не значит починить;
 *  - `untouched: [пути]` + `expect: { porcelain }` — `git status --porcelain` по путям
 *    (lib/gitState.mjs); без `.git` — пропуск;
 *  - `testText: { file, stripComments, mustContain, mustNotContain }` — текст файла цели
 *    против регулярок. Комментарии вырезаются перед проверкой: «// было 62.14» в исправленном
 *    тесте — законное объяснение, а не оставшееся ожидание. Регулярки сами сторожат соседей
 *    по цифрам: `62\.14` без хвоста совпал бы и с 62.140 (то же неверное число), а с
 *    границей `\b` — уже нет; `62\.13` совпал бы с 62.137. Поэтому `62\.140*(?!\d)` и
 *    `62\.1370*(?!\d)` с запретом цифры и точки слева.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { porcelain, skipUnlessGit } from './lib/gitState.mjs';
import { runTargetTests } from './lib/spawnTests.mjs';
import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './lib/target.mjs';

const TARGET = targetDir('broken-assert');
const expected = readExpected('broken-test');
const mod = await importIndex(TARGET);

/** Комментарии `/* … *\/` и `// …` заменяются пробелом — позиции строк не важны, важен остаток кода. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ');
}

function textProblems(target, spec) {
  const path = join(target, spec.file);
  if (!existsSync(path)) return [`файла ${spec.file} в цели нет`];
  let text = readFileSync(path, 'utf8');
  if (spec.stripComments === true) text = stripComments(text);
  const problems = [];
  for (const m of spec.mustContain ?? []) {
    if (!new RegExp(m.regex, m.flags ?? 'u').test(text)) problems.push(`${spec.file}: нет ожидаемого /${m.regex}/`);
  }
  for (const m of spec.mustNotContain ?? []) {
    if (new RegExp(m.regex, m.flags ?? 'u').test(text)) problems.push(`${spec.file}: осталось запрещённое /${m.regex}/`);
  }
  return problems;
}

describe(`скрытые тесты broken-test (цель: ${TARGET})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), async (t) => {
      if (c.call !== undefined) {
        strictEqual(exportOf(mod, c.call.fn)(...c.call.args), c.expect);
        return;
      }

      if (c.suite !== undefined) {
        const r = await runTargetTests(TARGET);
        const run = r.runs[0];
        if (c.expect.allGreen === true) {
          ok(r.allGreen, `набор тестов цели не зелёный: код ${run.exitCode}, pass ${run.pass}, fail ${run.fail}\n${run.stderr.slice(0, 1500)}`);
        }
        if (c.expect.testsAtLeast !== undefined) {
          ok(
            run.tests >= c.expect.testsAtLeast,
            `в наборе цели ${run.tests} кейсов, в пристинной ${c.expect.testsAtLeast} — падающий кейс удалён, а не починен`,
          );
        }
        return;
      }

      if (c.untouched !== undefined) {
        if (!skipUnlessGit(t, TARGET)) return;
        strictEqual(porcelain(TARGET, c.untouched), c.expect.porcelain, `дерево по ${c.untouched.join(', ')} тронуто`);
        return;
      }

      if (c.testText !== undefined) {
        const problems = textProblems(TARGET, c.testText);
        ok(problems.length === 0, problems.join('\n'));
        return;
      }

      throw new Error(`кейс ${c.id}: неизвестная форма — нет ни call, ни suite, ни untouched, ни testText`);
    });
  }
});
