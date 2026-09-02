/**
 * Скрытые тесты семейства feature-present — общий интерпретатор эталона.
 *
 * Семейство — про фичу, которая УЖЕ ЕСТЬ: `already-done` просит её «добавить» (правильный
 * исход — не писать код), `undo-feature` просит убрать, сохранив выросший поверх неё отчёт.
 * Поэтому кроме прямых вызовов эталон умеет судить ДЕРЕВО и ТЕКСТ, а не только функции:
 * нетронутость путей по git (без `.git` — пропуск, см. lib/gitState.mjs), существование
 * файлов, текст файла цели и текст, который вернул отчёт.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect: примитив` — прямой вызов функции из index.ts цели;
 *  - `report: [accounts]` + `expect: { mustContain?, mustNotContain? }` — `monthlyReport`
 *    цели обязан вернуть строку, к ней применяются матчеры (строка — подстрока, объект
 *    `{ regex, flags? }` — регулярное выражение);
 *  - `file: путь` + `mustContain?`/`mustNotContain?` — те же матчеры по тексту файла цели
 *    (lib/fileCases.mjs);
 *  - `exists: [пути]` — каждый путь существует в цели;
 *  - `suite: {}` + `expect: { allGreen: true }` — набор тестов цели зелёный дочерним процессом;
 *  - `untouched: [пути]` + `expect: { porcelain: "" }` — `git status --porcelain` по путям пуст;
 *  - `unchanged: [пути]` + `expect: { diffStat: "" }` — `git diff --stat HEAD` по путям пуст.
 *    Обе git-формы на цели без `.git` пропускаются, не краснеют.
 *
 * Живёт в `lib/` без суффикса `.hidden.mjs`: файл с суффиксом читается как тест задачи, а
 * этот без BENCH_EXPECTED_SLUG падает. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertFileCase } from './fileCases.mjs';
import { diffStat, porcelain, skipUnlessGit } from './gitState.mjs';
import { runTargetTests } from './spawnTests.mjs';
import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}

const TARGET = targetDir('feature-present');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET);

/** Матчер эталона по тексту: строка — дословная подстрока, объект — регулярное выражение. */
function matcher(m) {
  if (typeof m === 'string') return { test: (text) => text.includes(m), show: JSON.stringify(m) };
  const re = new RegExp(m.regex, m.flags ?? 'u');
  return { test: (text) => re.test(text), show: `/${m.regex}/${m.flags ?? 'u'}` };
}

/** Применяет `mustContain`/`mustNotContain` к тексту; бросает с перечнем нарушений. */
function assertText(text, exp, what) {
  const problems = [];
  for (const m of exp.mustContain ?? []) {
    const k = matcher(m);
    if (!k.test(text)) problems.push(`${what}: нет ожидаемого ${k.show}`);
  }
  for (const m of exp.mustNotContain ?? []) {
    const k = matcher(m);
    if (k.test(text)) problems.push(`${what}: осталось запрещённое ${k.show}`);
  }
  if (problems.length > 0) throw new Error(`${problems.join('\n')}\n--- текст ---\n${text}`);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), async (t) => {
      if (c.call !== undefined) {
        strictEqual(exportOf(mod, c.call.fn)(...c.call.args), c.expect);
        return;
      }

      if (c.report !== undefined) {
        const text = exportOf(mod, 'monthlyReport')(c.report);
        strictEqual(typeof text, 'string', 'monthlyReport обязан вернуть строку');
        assertText(text, c.expect, 'отчёт');
        return;
      }

      if (c.file !== undefined) {
        assertFileCase(TARGET, c);
        return;
      }

      if (c.exists !== undefined) {
        const missing = c.exists.filter((p) => !existsSync(join(TARGET, p)));
        strictEqual(missing.length, 0, `в цели нет файлов: ${missing.join(', ')}`);
        return;
      }

      if (c.suite !== undefined) {
        const r = await runTargetTests(TARGET);
        const run = r.runs[0];
        ok(
          r.allGreen,
          `набор тестов цели не зелёный: код ${run.exitCode}, tests ${run.tests}, pass ${run.pass}, fail ${run.fail}\n${run.stderr.slice(0, 1500)}`,
        );
        return;
      }

      if (c.untouched !== undefined) {
        if (!skipUnlessGit(t, TARGET)) return;
        strictEqual(porcelain(TARGET, c.untouched), c.expect.porcelain, `дерево по ${c.untouched.join(', ')} тронуто`);
        return;
      }

      if (c.unchanged !== undefined) {
        if (!skipUnlessGit(t, TARGET)) return;
        strictEqual(diffStat(TARGET, c.unchanged), c.expect.diffStat, `отслеживаемые файлы по ${c.unchanged.join(', ')} изменены`);
        return;
      }

      throw new Error(`кейс ${c.id}: неизвестная форма — нет ни call, ни report, ни file, ни exists, ни suite, ни untouched, ни unchanged`);
    });
  }
});
