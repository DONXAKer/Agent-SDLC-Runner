/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { add, formatRub, percent, rub, subtract } from './money.ts';
export type { Kopeck } from './money.ts';

export { loyaltyDiscount, loyaltyRate } from './loyalty.ts';
export type { Account } from './loyalty.ts';

export { orderTotal } from './order.ts';

export { REPORT_HEADER, monthlyReport, reportLine } from './report.ts';
