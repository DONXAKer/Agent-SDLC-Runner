/**
 * Тесты накопительной скидки — единственное место, где зафиксированы ступени и их границы.
 *
 * Сюда же собрано всё, что от скидки зависит в заказе и отчёте: тесты заказа и отчёта
 * проверяют только собственный контракт этих модулей и клиентов без накоплений, чтобы
 * ступени были записаны один раз, а не в трёх файлах с расходящимися числами.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loyaltyDiscount, loyaltyRate, monthlyReport, orderTotal, rub } from '../src/index.ts';

describe('накопительная скидка', () => {
  it('без покупок ставка 0', () => {
    strictEqual(loyaltyRate({ id: 'n', spentTotalK: 0 }), 0);
  });

  it('ровно 10 000 ₽ — граница включительно, скидки ещё нет', () => {
    strictEqual(loyaltyRate({ id: 'b', spentTotalK: rub(10_000) }), 0);
  });

  it('на копейку больше 10 000 ₽ — 3%', () => {
    strictEqual(loyaltyRate({ id: 'b', spentTotalK: rub(10_000) + 1 }), 3);
  });

  it('ровно 50 000 ₽ — всё ещё 3%', () => {
    strictEqual(loyaltyRate({ id: 'c', spentTotalK: rub(50_000) }), 3);
  });

  it('на копейку больше 50 000 ₽ — 7%', () => {
    strictEqual(loyaltyRate({ id: 'c', spentTotalK: rub(50_000) + 1 }), 7);
  });

  it('скидка считается общим округлением пакета — половина вверх', () => {
    // 12 345 × 3% = 370.35 → 370; 12 355 × 3% = 370.65 → 371
    strictEqual(loyaltyDiscount({ id: 'b', spentTotalK: rub(20_000) }, 12_345), 370);
    strictEqual(loyaltyDiscount({ id: 'b', spentTotalK: rub(20_000) }, 12_355), 371);
  });

  it('заказ постоянного клиента — минус 7% от позиций', () => {
    strictEqual(orderTotal({ id: 'c', spentTotalK: rub(100_000) }, rub(1_000)), 93_000);
  });

  it('отчёт показывает действующую ставку клиента', () => {
    strictEqual(
      monthlyReport([{ id: 'c-1', spentTotalK: rub(100_000) }]),
      'Клиент | Покупки | Скидка\nc-1 | 100 000,00 ₽ | 7 %',
    );
  });
});
