/**
 * Скрытые тесты семейства booking — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json` — один из входов:
 *  - `overlaps: [a, b]`                       — `overlaps(a, b)` цели, `expect` — boolean;
 *  - `isActive: { hold, at: {iso: bool} }`    — `isActive(hold, new Date(iso))` для каждой
 *    пары; hold — литерал, чтобы кейс не зависел от того, как считает срок `makeHold`;
 *  - `makeHold: { id, slot, now, warehouse? }` — `makeHold(id, slot, new Date(now)[, w])`;
 *    `warehouse` — индекс в `WAREHOUSES` ЦЕЛИ, не литерал: если модель добавила складу поле
 *    (пояс), литерал из эталона его бы не нёс, и кейс мерил бы эталон, а не решение;
 *  - `moveHold: { hold, newSlot }`             — `moveHold(hold, newSlot)`.
 *
 * `expect` для брони — карта проверок, сходятся все перечисленные: `id`; `slot`
 * (deepStrictEqual); `expiresIso` — сравнение МОМЕНТОВ, не строк: `…T21:00:00.000Z` и
 * `…T00:00:00+03:00` — один срок, и формат записи не предмет задачи; `expiresAfterNow`;
 * `expiresWithinHours: n`; `activeAt: {iso: bool}` — isActive результата; `argsUntouched` —
 * входной слот / входная бронь равны своему снимку до вызова; `slotIsCopy` — hold.slot !==
 * входной slot; `newObject` — результат !== входная бронь; `sourceUntouched` — входная бронь
 * равна снимку до вызова; `sourceActiveAt: {iso: bool}` — isActive ВХОДНОЙ брони после вызова.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство.
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const TARGET_DIR = targetDir('booking');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

const HOUR_MS = 3_600_000;

/** Момент из ISO-строки эталона; битая строка в эталоне — ошибка эталона, а не кейса. */
function ms(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`эталон: момент не разбирается как ISO 8601: ${iso}`);
  return t;
}

/** Склад цели по индексу: `WAREHOUSES` — часть публичного контракта, как и функции. */
function warehouseOf(index) {
  const list = mod.WAREHOUSES;
  if (!Array.isArray(list) || list[index] === undefined) {
    throw new Error(`src/index.ts не экспортирует WAREHOUSES[${index}] — контракт публичного API нарушен`);
  }
  return list[index];
}

/** `isActive` цели по карте {iso: ожидание}. */
function checkActiveAt(hold, at, where) {
  const isActive = exportOf(mod, 'isActive');
  for (const [iso, want] of Object.entries(at)) {
    strictEqual(isActive(hold, new Date(ms(iso))), want, `${where}isActive в ${iso}`);
  }
}

/** Общая часть карты ожиданий для брони-результата. */
function checkHold(got, e, ctx) {
  ok(typeof got === 'object' && got !== null, 'результат — не бронь');
  if (e.id !== undefined) strictEqual(got.id, e.id, 'id');
  if (e.slot !== undefined) deepStrictEqual(got.slot, e.slot, 'slot');
  if (e.expiresIso !== undefined) {
    strictEqual(typeof got.expiresIso, 'string', 'expiresIso обязан быть строкой ISO 8601');
    strictEqual(
      ms(got.expiresIso),
      ms(e.expiresIso),
      `expiresIso: получено ${got.expiresIso}, ожидался момент ${e.expiresIso}`,
    );
  }
  if (e.expiresAfterNow === true) {
    ok(ms(got.expiresIso) > ctx.now, `expiresIso ${got.expiresIso} не позже now ${new Date(ctx.now).toISOString()}`);
  }
  if (e.expiresWithinHours !== undefined) {
    const span = ms(got.expiresIso) - ctx.now;
    ok(
      span <= e.expiresWithinHours * HOUR_MS,
      `expiresIso ${got.expiresIso} дальше ${e.expiresWithinHours} ч от now — это не конец суток`,
    );
  }
  if (e.activeAt !== undefined) checkActiveAt(got, e.activeAt, 'результат: ');
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      const e = c.expect;

      if (c.overlaps !== undefined) {
        const [a, b] = c.overlaps;
        strictEqual(exportOf(mod, 'overlaps')(a, b), e, `overlaps(${a.startIso}–${a.endIso}, ${b.startIso}–${b.endIso})`);
        return;
      }

      if (c.isActive !== undefined) {
        checkActiveAt(c.isActive.hold, c.isActive.at, '');
        return;
      }

      if (c.makeHold !== undefined) {
        const { id, slot, now, warehouse } = c.makeHold;
        const snapshot = structuredClone(slot);
        const nowMs = ms(now);
        const args = [id, slot, new Date(nowMs)];
        if (warehouse !== undefined) args.push(warehouseOf(warehouse));
        const got = exportOf(mod, 'makeHold')(...args);
        checkHold(got, e, { now: nowMs });
        if (e.argsUntouched === true) deepStrictEqual(slot, snapshot, 'входной слот изменён');
        if (e.slotIsCopy === true) notStrictEqual(got.slot, slot, 'бронь ссылается на входной слот, а не на свой снимок');
        return;
      }

      if (c.moveHold !== undefined) {
        const { hold, newSlot } = c.moveHold;
        const holdSnapshot = structuredClone(hold);
        const slotSnapshot = structuredClone(newSlot);
        const got = exportOf(mod, 'moveHold')(hold, newSlot);
        checkHold(got, e, { now: Number.NaN });
        if (e.newObject === true) notStrictEqual(got, hold, 'moveHold вернул исходную бронь, а не новую');
        if (e.sourceUntouched === true) deepStrictEqual(hold, holdSnapshot, 'исходная бронь изменена');
        if (e.argsUntouched === true) deepStrictEqual(newSlot, slotSnapshot, 'входной слот изменён');
        if (e.sourceActiveAt !== undefined) checkActiveAt(hold, e.sourceActiveAt, 'исходная бронь: ');
        return;
      }

      throw new Error(`кейс ${c.id}: не задан ни один из входов overlaps/isActive/makeHold/moveHold`);
    });
  }
});
