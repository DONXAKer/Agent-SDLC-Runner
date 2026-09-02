/**
 * Текстовый отчёт.
 *
 * Отчёт уходит в письмо и в консоль, поэтому это моноширинная таблица, а не HTML: письмо
 * читают в почтовике без стилей, и таблица обязана выравниваться пробелами. Ширина колонок
 * считается по содержимому — имена менеджеров и суммы разной длины, фиксированная ширина
 * либо обрезала бы длинные фамилии, либо раздувала бы таблицу для коротких.
 */

import { aggregate } from './aggregate.ts';
import type { SaleRow } from './rows.ts';

const HEADER_MANAGER = 'Менеджер';
const HEADER_TOTAL = 'Сумма';

/**
 * «1 234,56 ₽» — копейки в строку с разрядами. Рубли с плавающей точкой не появляются и
 * здесь: деление на 100 сделано целочисленно, копейки — остаток.
 */
function formatRub(amountK: number): string {
  const whole = Math.floor(amountK / 100);
  const cents = amountK % 100;
  const groups = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${groups},${String(cents).padStart(2, '0')} ₽`;
}

/** Таблица свода: заголовок, разделитель, строка на менеджера; пустой свод — одна строка. */
export function renderReport(rows: readonly SaleRow[]): string {
  const totals = aggregate(rows);
  if (totals.length === 0) return 'Отчёт пуст\n';

  const sums = totals.map((t) => formatRub(t.totalK));
  const nameWidth = Math.max(HEADER_MANAGER.length, ...totals.map((t) => t.manager.length));
  const sumWidth = Math.max(HEADER_TOTAL.length, ...sums.map((s) => s.length));
  const line = (name: string, sum: string): string => `${name.padEnd(nameWidth)}  ${sum.padStart(sumWidth)}`;

  const out = [line(HEADER_MANAGER, HEADER_TOTAL), `${'-'.repeat(nameWidth)}  ${'-'.repeat(sumWidth)}`];
  totals.forEach((t, i) => out.push(line(t.manager, sums[i] ?? '')));
  return `${out.join('\n')}\n`;
}
