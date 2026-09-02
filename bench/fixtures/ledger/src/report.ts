/**
 * Отчёт по складу.
 *
 * Отчёт печатается для сверки с актом инвентаризации, поэтому он показывает то же, что
 * увидит поиск: одну строку на позицию, и при дубликате — количество ПЕРВОЙ записи. Отчёт,
 * складывающий дубликаты или показывающий обе строки, с актом не сойдётся.
 */

import { STOCK_TABLE, findEntry } from './stock.ts';
import type { Warehouse } from './stock.ts';

/** Строка отчёта: та же форма, что у записи таблицы, — отчёт и есть срез таблицы. */
export interface ReportRow {
  sku: string;
  qty: number;
}

/**
 * Позиции склада в порядке первого появления в таблице, по одной строке на sku.
 *
 * Количество берётся через findEntry, а не из текущей строки: так отчёт и поиск
 * гарантированно отвечают одинаково, даже если правило выбора записи когда-нибудь сменится.
 */
export function stockReport(warehouse: Warehouse): ReportRow[] {
  const seen = new Set<string>();
  const rows: ReportRow[] = [];
  for (const row of STOCK_TABLE[warehouse]) {
    if (seen.has(row.sku)) continue;
    seen.add(row.sku);
    const entry = findEntry(warehouse, row.sku);
    // Строка есть в таблице — findEntry обязан её найти; иначе поиск и таблица разошлись.
    if (entry === null) throw new Error(`поиск не видит строку таблицы: ${warehouse} ${row.sku}`);
    rows.push({ sku: entry.sku, qty: entry.qty });
  }
  return rows;
}
