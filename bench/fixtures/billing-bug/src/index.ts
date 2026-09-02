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

export { buildInvoice } from './invoice.ts';
export type { Invoice } from './invoice.ts';

import { buildInvoice } from './invoice.ts';
import type { Invoice } from './invoice.ts';
import type { Line } from './lines.ts';
import type { Kopeck } from './money.ts';

/** Точка входа для вызывающих: выставить счёт. Без доставки и скидки — самовывоз по прайсу. */
export function bill(number: string, lines: readonly Line[], deliveryK: Kopeck = 0, discountPct = 0): Invoice {
  return buildInvoice(number, lines, deliveryK, discountPct);
}
