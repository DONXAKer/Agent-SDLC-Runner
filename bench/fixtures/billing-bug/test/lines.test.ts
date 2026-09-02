/**
 * Тесты позиций и подытога.
 *
 * Цены и ставки здесь круглые: 10% от 500 — целые 50 копеек, делить и округлять нечего.
 * Правило округления фиксируют тесты денег, а не эти.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineTotal, subtotal } from '../src/index.ts';

describe('позиции счёта', () => {
  it('стоимость позиции — количество на цену', () => {
    strictEqual(lineTotal({ title: 'Пакет', qty: 2, priceK: 333 }), 666);
  });

  it('скидка позиции уменьшает стоимость строки', () => {
    strictEqual(lineTotal({ title: 'Коробка', qty: 2, priceK: 500, discountPct: 10 }), 900);
    strictEqual(lineTotal({ title: 'Лента', qty: 1, priceK: 1_000, discountPct: 25 }), 750);
  });

  it('подытог — сумма по позициям', () => {
    const lines = [
      { title: 'Пакет', qty: 2, priceK: 333 },
      { title: 'Коробка', qty: 1, priceK: 334 },
      { title: 'Лента', qty: 4, priceK: 250, discountPct: 20 },
    ];
    strictEqual(subtotal(lines), 1_800);
  });

  it('пустой счёт — нулевой подытог', () => {
    strictEqual(subtotal([]), 0);
  });
});
