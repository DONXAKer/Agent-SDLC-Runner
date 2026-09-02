/**
 * Тесты резерва.
 *
 * Граница включающая — «остатка впритык хватает» — проверяется отдельным кейсом, потому что
 * это правило склада, а не деталь реализации: ошибка на единицу здесь оставляет последнюю
 * штуку никому не проданной.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { keyFor, reserve, reservedFor } from '../src/index.ts';

describe('резерв', () => {
  it('ставится, когда остатка хватает', () => {
    deepStrictEqual(reserve('wh-msk', 'AZ-123', 10), { ok: true });
  });

  it('остатка впритык хватает — граница включающая', () => {
    deepStrictEqual(reserve('wh-msk', 'BX-770', 12), { ok: true });
  });

  it('на единицу больше остатка — отказ с причиной', () => {
    const r = reserve('wh-msk', 'BX-770', 13);
    strictEqual(r.ok, false);
    strictEqual(r.ok === false && r.reason.length > 0, true);
  });

  it('неизвестная позиция — отказ, не исключение', () => {
    strictEqual(reserve('wh-vld', 'BX-770', 1).ok, false);
  });

  it('позиция уже в резерве — второй резерв не ставится', () => {
    strictEqual(reservedFor('wh-spb', 'BX-770'), 7);
    strictEqual(reserve('wh-spb', 'BX-770', 1).ok, false);
  });

  it('нецелое или неположительное количество — отказ', () => {
    strictEqual(reserve('wh-msk', 'AZ-123', 0).ok, false);
    strictEqual(reserve('wh-msk', 'AZ-123', 1.5).ok, false);
  });
});

describe('ключ записи', () => {
  it('склад и позиция через разделитель', () => {
    strictEqual(keyFor('wh-msk', 'AZ-123'), 'wh-msk#AZ-123');
  });

  it('резерв без записи — ноль', () => {
    strictEqual(reservedFor('wh-msk', 'AZ-123'), 0);
  });
});
