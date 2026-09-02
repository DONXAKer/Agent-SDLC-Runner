/**
 * Свод продаж по менеджерам.
 *
 * Руководителю отдела нужны итоги по людям, а не по чекам: одна строка на менеджера и сумма
 * его продаж за период. Мелочь в свод не попадает — стажёр с одним чеком за месяц не должен
 * стоять в одной таблице с теми, у кого план.
 */

import type { SaleRow } from './rows.ts';

/** Строка свода: менеджер и его сумма за период, в копейках. */
export interface ManagerTotal {
  manager: string;
  totalK: number;
}

/**
 * Порог попадания в свод — 1000 ₽ в копейках. В свод идут менеджеры, чья сумма строго
 * больше порога: ровно 1000 ₽ — это ещё «мелочь», руководитель её смотреть не хочет.
 */
export const THRESHOLD_K = 1000_00;

/**
 * Свод: группировка по менеджеру, отсев по порогу, сортировка по возрастанию суммы —
 * руководитель читает таблицу снизу вверх, лучшие в конце. Порядок менеджеров с равной
 * суммой не определён и зависит от порядка строк на входе.
 */
export function aggregate(rows: readonly SaleRow[]): ManagerTotal[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.manager, (totals.get(row.manager) ?? 0) + row.amountK);
  }

  const result: ManagerTotal[] = [];
  for (const [manager, totalK] of totals) {
    if (totalK >= THRESHOLD_K) result.push({ manager, totalK });
  }

  result.sort((a, b) => b.totalK - a.totalK || a.manager.localeCompare(b.manager, 'ru'));
  return result;
}
