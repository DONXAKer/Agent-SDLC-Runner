/**
 * Тесты брони.
 *
 * Момент «сейчас» здесь всегда задан явно (`fixedClock`), системных часов тесты не видят.
 * Проверяются инварианты брони — действует сразу после создания, аргументы не мутируются,
 * до срока действует, после срока нет — а не конкретное значение срока: срок задан
 * бизнес-правилом в `hold.ts`, и его перемена не должна ронять тест про иммутабельность.
 */

import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fixedClock, isActive, makeHold } from '../src/index.ts';
import type { Hold, Slot } from '../src/index.ts';

const now = fixedClock('2026-03-10T10:00:00Z');
const slot: Slot = { startIso: '2026-03-20T06:00:00Z', endIso: '2026-03-20T08:00:00Z' };

describe('makeHold', () => {
  it('переносит идентификатор и слот в бронь', () => {
    const hold = makeHold('h-1', slot, now());
    strictEqual(hold.id, 'h-1');
    deepStrictEqual(hold.slot, slot);
  });

  it('бронь действует сразу после создания', () => {
    strictEqual(isActive(makeHold('h-1', slot, now()), now()), true);
  });

  it('слот, который уже начался, бронировать поздно', () => {
    const late = fixedClock('2026-03-20T06:00:00Z');
    throws(() => makeHold('h-1', slot, late()), RangeError);
  });

  it('пустой идентификатор отвергается', () => {
    throws(() => makeHold('   ', slot, now()), RangeError);
  });

  it('не мутирует аргументы и возвращает новый объект', () => {
    const before = { ...slot };
    const first = makeHold('h-1', slot, now());
    const second = makeHold('h-1', slot, now());

    deepStrictEqual(slot, before, 'входной слот изменился');
    notStrictEqual(first.slot, slot, 'бронь хранит свой снимок слота, а не ссылку на чужой объект');
    deepStrictEqual(first.slot, slot);
    notStrictEqual(first, second, 'два вызова — два объекта');
    notStrictEqual(first.slot, second.slot);
  });
});

describe('isActive', () => {
  const hold: Hold = { id: 'h-2', slot, expiresIso: '2026-03-12T09:00:00Z' };

  it('до срока бронь действует', () => {
    strictEqual(isActive(hold, fixedClock('2026-03-12T08:59:00Z')()), true);
  });

  it('после срока бронь не действует', () => {
    strictEqual(isActive(hold, fixedClock('2026-03-12T09:01:00Z')()), false);
  });

  it('бронь с нечитаемым сроком отвергается, а не считается истёкшей', () => {
    throws(() => isActive({ ...hold, expiresIso: 'скоро' }, now()), RangeError);
  });
});
