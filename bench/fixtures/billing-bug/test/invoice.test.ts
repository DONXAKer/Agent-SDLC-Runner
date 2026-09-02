/**
 * Тесты сборки счёта.
 *
 * Форма Invoice — {number, lines, deliveryK, discountPct, subtotal, total} — контракт: её
 * сверяют литералом, и новое поле появляется в ней только когда ему есть что сказать.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bill, rub } from '../src/index.ts';

describe('сборка счёта', () => {
  it('итог — подытог плюс доставка, когда скидки нет', () => {
    const inv = bill('СЧ-1', [
      { title: 'Стол', qty: 1, priceK: rub(12_990) },
      { title: 'Стул', qty: 4, priceK: rub(2_490) },
    ], rub(1_500), 0);
    strictEqual(inv.subtotal, 2_295_000);
    strictEqual(inv.total, 2_445_000);
  });

  it('скидка счёта при самовывозе — процент от подытога', () => {
    const inv = bill('СЧ-2', [{ title: 'Шкаф', qty: 1, priceK: rub(45_000) }], 0, 10);
    strictEqual(inv.subtotal, 4_500_000);
    strictEqual(inv.total, 4_050_000);
  });

  it('форма счёта — ровно шесть полей', () => {
    const inv = bill('СЧ-3', [{ title: 'Пакет', qty: 1, priceK: 100 }]);
    deepStrictEqual(Object.keys(inv).sort(), ['deliveryK', 'discountPct', 'lines', 'number', 'subtotal', 'total']);
    strictEqual(inv.number, 'СЧ-3');
    strictEqual(inv.deliveryK, 0);
    strictEqual(inv.discountPct, 0);
  });
});
