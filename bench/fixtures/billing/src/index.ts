/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { add, formatRub, percent, rub, subtract } from './money.ts';
export type { Kopeck } from './money.ts';

export { lineTotal, subtotal } from './lines.ts';
export type { Line } from './lines.ts';

export type { Customer } from './customer.ts';

export { DEFAULT_CONFIG, resolveConfig } from './config.ts';
export type { BillingConfig } from './config.ts';

export { buildInvoice } from './invoice.ts';
export type { Invoice } from './invoice.ts';

import { buildInvoice } from './invoice.ts';
import type { BillingConfig } from './config.ts';
import type { Customer } from './customer.ts';
import type { Invoice } from './invoice.ts';
import type { Line } from './lines.ts';

/** Точка входа для вызывающих: выставить счёт. */
export function bill(
  number: string,
  customer: Customer,
  lines: readonly Line[],
  config?: Partial<BillingConfig>,
): Invoice {
  return buildInvoice(number, customer, lines, config);
}
