/**
 * Тесты сборки счёта.
 *
 * Счёт без налогов: итог совпадает с подытогом, форма Invoice — {number, customer, lines,
 * subtotal, total}. Форма — контракт: её сверяют литералом, поэтому новые поля появляются
 * в Invoice только когда им есть что сказать.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bill } from '../src/index.ts';

const customer = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

describe('сборка счёта', () => {
  it('итог совпадает с подытогом, пока налогов нет', () => {
    const inv = bill('СЧ-1', customer, [
      { title: 'Пакет', qty: 2, priceK: 333 },
      { title: 'Коробка', qty: 1, priceK: 334 },
    ]);
    strictEqual(inv.subtotal, 1_000);
    strictEqual(inv.total, 1_000);
  });

  it('форма счёта — ровно пять полей', () => {
    const inv = bill('СЧ-2', customer, [{ title: 'Пакет', qty: 1, priceK: 100 }]);
    deepStrictEqual(Object.keys(inv).sort(), ['customer', 'lines', 'number', 'subtotal', 'total']);
    strictEqual(inv.number, 'СЧ-2');
  });
});
