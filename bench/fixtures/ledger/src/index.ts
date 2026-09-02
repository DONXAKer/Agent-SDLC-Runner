/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { STOCK_TABLE, WAREHOUSES, findEntry, isWarehouse, stockOf, totalQty } from './stock.ts';
export type { StockEntry, Warehouse } from './stock.ts';

export { KEY_SEPARATOR, keyFor } from './keys.ts';

export { RESERVED, reserve, reservedFor } from './reserve.ts';
export type { ReserveOptions, ReserveResult } from './reserve.ts';

export { stockReport } from './report.ts';
export type { ReportRow } from './report.ts';

import { keyFor } from './keys.ts';
import { stockReport } from './report.ts';
import { reserve, reservedFor } from './reserve.ts';
import { findEntry, stockOf, totalQty } from './stock.ts';

/**
 * Фасад для вызывающих: один объект вместо десятка импортов.
 *
 * Заморожен, чтобы потребитель не подменял функции пакета своими: подмена `find` без подмены
 * `report` разводила бы поиск и отчёт, которые обязаны отвечать одинаково.
 */
export const api = Object.freeze({
  find: findEntry,
  stockOf,
  totalQty,
  reserve,
  reservedFor,
  report: stockReport,
  keyFor,
});
