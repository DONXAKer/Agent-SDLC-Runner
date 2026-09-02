/**
 * Скрытые тесты семейства billing — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect: число|строка|boolean` — прямой вызов функции из index.ts
 *    цели, `strictEqual`;
 *  - `call: { fn, args }` + `expect: массив` — вызов и deepStrictEqual (validateCustomer);
 *  - `bill: { number, lines, customer?, config?, opts? }` + `expect: { subtotal?, vat?,
 *    vatAbsent?, dueDays?, issuer?, issuerAbsent?, total? }` — сборка счёта через bill();
 *    проверяются только перечисленные ключи; `*Absent: true` означает «поля нет вовсе».
 *  Любая другая форма — ошибка ЭТАЛОНА с понятным текстом, а не `not ok`, засчитанный модели.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство
 * (`lib/target.mjs`).
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер. Один процесс — одна
 * обёртка: модуль кэшируется ESM, второй импорт под другим слагом не выполнится.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const TARGET_DIR = targetDir('billing');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

const CUSTOMER = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

function malformed(c, why) {
  return new Error(`эталон ${SLUG}, кейс ${c.id}: ${why} — это брак эталона, не провал модели`);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      if (c.call !== undefined) {
        if (typeof c.call.fn !== 'string' || !Array.isArray(c.call.args)) throw malformed(c, 'call обязан быть { fn: строка, args: массив }');
        const got = exportOf(mod, c.call.fn)(...c.call.args);
        if (Array.isArray(c.expect)) {
          deepStrictEqual(got, c.expect);
        } else if (c.expect !== null && typeof c.expect === 'object') {
          throw malformed(c, 'expect-объект у call не поддерживается (только скаляр или массив)');
        } else {
          strictEqual(got, c.expect);
        }
        return;
      }

      if (c.bill === undefined) throw malformed(c, 'нет ни call, ни bill');
      const b = c.bill;
      if (typeof b.number !== 'string' || !Array.isArray(b.lines)) throw malformed(c, 'bill обязан нести number и lines');
      const inv = exportOf(mod, 'bill')(b.number, b.customer ?? CUSTOMER, b.lines, b.config, b.opts);
      const e = c.expect;
      if (e === null || typeof e !== 'object') throw malformed(c, 'expect у bill обязан быть объектом');
      if (e.subtotal !== undefined) strictEqual(inv.subtotal, e.subtotal, 'subtotal');
      if (e.total !== undefined) strictEqual(inv.total, e.total, 'total');
      if (e.vat !== undefined) strictEqual(inv.vat, e.vat, 'vat');
      if (e.vatAbsent === true) strictEqual('vat' in inv, false, 'поля vat не должно быть вовсе');
      if (e.dueDays !== undefined) strictEqual(inv.dueDays, e.dueDays, 'dueDays');
      if (e.issuer !== undefined) strictEqual(inv.issuer, e.issuer, 'issuer');
      if (e.issuerAbsent === true) strictEqual('issuer' in inv, false, 'поля issuer не должно быть вовсе');
    });
  }
});
