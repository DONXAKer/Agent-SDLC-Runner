/**
 * Тесты позиций и подытога.
 *
 * Значения подобраны так, чтобы существующее покрытие не пересекалось с задачами витка:
 * здесь нет ни налогов, ни скидок — строки складываются, и всё.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineTotal, subtotal } from '../src/index.ts';

describe('позиции счёта', () => {
  it('стоимость позиции — количество на цену', () => {
    strictEqual(lineTotal({ title: 'Пакет', qty: 2, priceK: 333 }), 666);
  });

  it('подытог — сумма по позициям', () => {
    const lines = [
      { title: 'Пакет', qty: 2, priceK: 333 },
      { title: 'Коробка', qty: 1, priceK: 334 },
    ];
    strictEqual(subtotal(lines), 1_000);
  });

  it('пустой счёт — нулевой подытог', () => {
    strictEqual(subtotal([]), 0);
  });
});
