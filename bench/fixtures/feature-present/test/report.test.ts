/**
 * Тесты отчёта.
 *
 * Отчёт — контракт формата: шапка, разделитель колонок, по строке на клиента. Здесь
 * закреплён именно формат, на клиентах без накоплений; какая ставка у кого действует —
 * предмет loyalty.test.ts.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REPORT_HEADER, monthlyReport, reportLine, rub } from '../src/index.ts';

describe('ежемесячный отчёт', () => {
  it('шапка — три колонки через « | »', () => {
    strictEqual(REPORT_HEADER, 'Клиент | Покупки | Скидка');
  });

  it('пустой список клиентов — только шапка', () => {
    strictEqual(monthlyReport([]), 'Клиент | Покупки | Скидка');
  });

  it('строка клиента без накоплений — сумма в рублях и нулевая скидка', () => {
    strictEqual(reportLine({ id: 'n-1', spentTotalK: rub(2_500) }), 'n-1 | 2 500,00 ₽ | 0 %');
  });

  it('по строке на клиента, порядок — как передали', () => {
    const text = monthlyReport([
      { id: 'n-1', spentTotalK: 0 },
      { id: 'n-2', spentTotalK: rub(10_000) },
    ]);
    strictEqual(text.split('\n').length, 3);
    strictEqual(text.split('\n')[1], 'n-1 | 0,00 ₽ | 0 %');
    strictEqual(text.split('\n')[2], 'n-2 | 10 000,00 ₽ | 0 %');
  });
});
