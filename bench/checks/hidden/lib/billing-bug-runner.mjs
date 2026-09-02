/**
 * Скрытые тесты семейства billing-bug — общий интерпретатор эталона.
 *
 * Семейство — про ПОСЕЯННЫЕ баги: пристинный код врёт README, набор тестов пристинной
 * зелёный (баги вне покрытия). Поэтому кроме прямых вызовов эталон умеет два вопроса, которых
 * нет у `billing-runner.mjs`: «появился ли новый тест» (набор цели гоняется дочерним
 * процессом, кейсов обязано стать больше, чем в пристинной) и «не тронут ли файл, на который
 * клевещет ТЗ» (git status по пути; без `.git` — пропуск, см. lib/gitState.mjs).
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect: число` — прямой вызов функции из index.ts цели;
 *  - `bill: { number, lines, deliveryK, discountPct }` + `expect: { subtotal?, total? }` —
 *    сборка счёта через bill(); проверяются только перечисленные ключи;
 *  - `suite: {}` + `expect: { allGreen: true, testsAbove: N }` — набор тестов цели зелёный и
 *    в нём строго больше N кейсов (N — счёт пристинной, записан в эталоне руками);
 *  - `untouched: [пути]` + `expect: { porcelain: "" }` — `git status --porcelain` по путям
 *    пуст; на цели без `.git` кейс пропускается.
 *
 * Живёт в `lib/` без суффикса `.hidden.mjs`: файл с суффиксом читается как тест задачи, а
 * этот без BENCH_EXPECTED_SLUG падает. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { porcelain, skipUnlessGit } from './gitState.mjs';
import { runTargetTests } from './spawnTests.mjs';
import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}

const TARGET = targetDir('billing-bug');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET);

describe(`скрытые тесты ${SLUG} (цель: ${TARGET})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), async (t) => {
      if (c.call !== undefined) {
        strictEqual(exportOf(mod, c.call.fn)(...c.call.args), c.expect);
        return;
      }

      if (c.bill !== undefined) {
        const b = c.bill;
        const inv = exportOf(mod, 'bill')(b.number, b.lines, b.deliveryK, b.discountPct);
        if (c.expect.subtotal !== undefined) strictEqual(inv.subtotal, c.expect.subtotal, 'subtotal');
        if (c.expect.total !== undefined) strictEqual(inv.total, c.expect.total, 'total');
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
            `в наборе цели ${run.tests} кейсов — новый регрессионный тест не появился (в пристинной ${c.expect.testsAbove})`,
          );
        }
        return;
      }

      if (c.untouched !== undefined) {
        if (!skipUnlessGit(t, TARGET)) return;
        strictEqual(porcelain(TARGET, c.untouched), c.expect.porcelain, `дерево по ${c.untouched.join(', ')} тронуто`);
        return;
      }

      throw new Error(`кейс ${c.id}: неизвестная форма — нет ни call, ни bill, ни suite, ни untouched`);
    });
  }
});
