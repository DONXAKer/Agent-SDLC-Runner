/**
 * Скрытые тесты семейства catalog — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json` — один из входов:
 *  - `construct: [args]`              — `product(...args)` цели;
 *  - `parse: строка`                  — `parse(строка)`;
 *  - `roundTrip: { construct | value }` — `parse(serialize(x))`, где x собран конструктором
 *    либо взят литералом;
 *  - `serialize: объект`              — `serialize(объект)`, результат — строка;
 *  - `loadAll: текст`                 — `loadAll(текст)`, результат — массив записей.
 *
 * `expect` для записи — карта полей: `id` сверяется как `sku ?? code` (regression-кейсы не
 * знают, как поле зовётся сегодня — задача rename-field его переименовывает), остальные
 * ключи (`sku`, `code`, `title`, `priceK`, `vatRate`) — по имени; `absent: [ключи]` —
 * «поля нет вовсе»; `equals: объект` — deepStrictEqual целиком. Для строки —
 * `{ contains: [], notContains: [] }` по подстрокам. Для массива — `{ length, items: [карты] }`.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство.
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const TARGET_DIR = targetDir('catalog');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

const FIELD_KEYS = ['sku', 'code', 'title', 'priceK', 'vatRate'];

/** Сверка одной записи с картой полей эталона. */
function checkRecord(got, e, where = '') {
  ok(typeof got === 'object' && got !== null, `${where}результат — не запись`);
  if (e.equals !== undefined) {
    deepStrictEqual(got, e.equals, `${where}запись целиком`);
    return;
  }
  if (e.id !== undefined) strictEqual(got.sku ?? got.code, e.id, `${where}идентификатор (sku ?? code)`);
  for (const k of FIELD_KEYS) {
    if (e[k] !== undefined) strictEqual(got[k], e[k], `${where}${k}`);
  }
  for (const k of e.absent ?? []) {
    strictEqual(k in got, false, `${where}поле ${k} обязано отсутствовать`);
  }
}

function build(x) {
  if (x.construct !== undefined) return exportOf(mod, 'product')(...x.construct);
  return x.value;
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      const e = c.expect;

      if (c.construct !== undefined) {
        checkRecord(exportOf(mod, 'product')(...c.construct), e);
        return;
      }
      if (c.parse !== undefined) {
        checkRecord(exportOf(mod, 'parse')(c.parse), e);
        return;
      }
      if (c.roundTrip !== undefined) {
        const line = exportOf(mod, 'serialize')(build(c.roundTrip));
        checkRecord(exportOf(mod, 'parse')(line), e);
        return;
      }
      if (c.serialize !== undefined) {
        const line = exportOf(mod, 'serialize')(c.serialize);
        strictEqual(typeof line, 'string', 'serialize обязан вернуть строку');
        for (const s of e.contains ?? []) ok(line.includes(s), `в строке нет ${JSON.stringify(s)}: ${line}`);
        for (const s of e.notContains ?? []) ok(!line.includes(s), `в строке осталось ${JSON.stringify(s)}: ${line}`);
        return;
      }
      if (c.loadAll !== undefined) {
        const items = exportOf(mod, 'loadAll')(c.loadAll);
        ok(Array.isArray(items), 'loadAll обязан вернуть массив');
        strictEqual(items.length, e.length, 'число записей');
        (e.items ?? []).forEach((ie, i) => checkRecord(items[i], ie, `[${i}] `));
        return;
      }
      throw new Error(`кейс ${c.id}: не задан ни один из входов construct/parse/roundTrip/serialize/loadAll`);
    });
  }
});
