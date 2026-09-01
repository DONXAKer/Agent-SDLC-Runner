/**
 * Скрытые тесты семейства billing — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect: число` — прямой вызов функции из index.ts цели;
 *  - `call: { fn, args }` + `expect: массив` — вызов и deepStrictEqual (validateCustomer);
 *  - `bill: { number, lines, customer?, config?, opts? }` + `expect: { subtotal?, vat?,
 *    vatAbsent?, dueDays?, issuer?, issuerAbsent?, total? }` — сборка счёта через bill();
 *    проверяются только перечисленные ключи; `*Absent: true` означает «поля нет вовсе».
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство.
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const EXPECTED_PATH = resolve(HERE, '..', '..', '..', 'expected', `${SLUG}.json`);
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', '..', 'fixtures', 'billing');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

const CUSTOMER = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    const label = `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;

    it(label, () => {
      if (c.call !== undefined) {
        const fn = mod[c.call.fn];
        if (typeof fn !== 'function') {
          throw new Error(`src/index.ts не экспортирует ${c.call.fn} — контракт публичного API нарушен`);
        }
        const got = fn(...c.call.args);
        if (Array.isArray(c.expect)) {
          deepStrictEqual(got, c.expect);
        } else {
          strictEqual(got, c.expect);
        }
        return;
      }

      if (typeof mod.bill !== 'function') {
        throw new Error('src/index.ts не экспортирует bill(...) — контракт публичного API нарушен');
      }
      const b = c.bill;
      const inv = mod.bill(b.number, b.customer ?? CUSTOMER, b.lines, b.config, b.opts);
      const e = c.expect;
      if (e.subtotal !== undefined) strictEqual(inv.subtotal, e.subtotal, 'subtotal');
      if (e.vat !== undefined) strictEqual(inv.vat, e.vat, 'vat');
      if (e.vatAbsent === true) strictEqual('vat' in inv, false, 'поле vat обязано отсутствовать, а не быть нулём');
      if (e.dueDays !== undefined) strictEqual(inv.dueDays, e.dueDays, 'dueDays');
      if (e.issuer !== undefined) strictEqual(inv.issuer, e.issuer, 'issuer');
      if (e.issuerAbsent === true) strictEqual('issuer' in inv, false, 'поле issuer обязано отсутствовать');
      if (e.total !== undefined) strictEqual(inv.total, e.total, 'total');
    });
  }
});
