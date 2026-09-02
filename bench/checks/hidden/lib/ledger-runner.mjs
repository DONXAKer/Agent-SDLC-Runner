/**
 * Скрытые тесты семейства ledger — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json` — вызов функций публичного `src/index.ts` цели:
 *  - `call: { fn, args }` — вызов; аргумент вида `{ "$call": { fn, args } }` подставляется
 *    результатом другого вызова (так `indexedFind` получает индекс от `buildStockIndex`,
 *    не зная, как тот устроен внутри);
 *  - `pick: "<ключ>"` — из результата берётся одно поле (`stockIndex('wh-msk')['BX-770']`);
 *    с `expectAbsent: true` кейс требует, чтобы ключа в объекте НЕ было — «нет позиции»
 *    и «позиция с нулём» здесь разные ответы;
 *  - `expectOk: true|false` — у результата вида `{ ok, reason? }` сверяется только `ok`
 *    (тексты причин отказа модели не диктуются), при отказе `reason` обязан быть строкой;
 *  - `same: [call, call]` — два вызова обязаны дать одинаковый результат (канонизация ключа:
 *    какой именно шаблон, кейсу не важно, важно совпадение);
 *  - иначе `expect` — примитив сверяется строго, объект и массив — глубоко.
 *
 * Живёт в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const TARGET_DIR = targetDir('ledger');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

function resolveArg(arg) {
  if (arg !== null && typeof arg === 'object' && !Array.isArray(arg) && '$call' in arg) {
    return invoke(arg.$call);
  }
  return arg;
}

function invoke(call) {
  const fn = exportOf(mod, call.fn);
  return fn(...(call.args ?? []).map(resolveArg));
}

function assertValue(got, exp) {
  if (exp !== null && typeof exp === 'object') deepStrictEqual(got, exp);
  else strictEqual(got, exp);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      if (c.same !== undefined) {
        const [a, b] = c.same.map(invoke);
        deepStrictEqual(a, b, 'оба вызова обязаны дать один результат');
        return;
      }

      let got = invoke(c.call);

      if (c.pick !== undefined) {
        if (got === null || typeof got !== 'object') {
          throw new Error(`${c.call.fn} вернул не объект (${String(got)}), поле ${c.pick} взять нельзя`);
        }
        if (c.expectAbsent === true) {
          strictEqual(Object.hasOwn(got, c.pick), false, `ключа ${c.pick} в результате быть не должно`);
          return;
        }
        got = got[c.pick];
      }

      if (c.expectOk !== undefined) {
        if (got === null || typeof got !== 'object') {
          throw new Error(`${c.call.fn} вернул не объект-результат (${String(got)})`);
        }
        strictEqual(got.ok, c.expectOk, 'ok');
        if (c.expectOk === false) strictEqual(typeof got.reason, 'string', 'отказ обязан назвать причину');
        return;
      }

      assertValue(got, c.expect);
    });
  }
});
