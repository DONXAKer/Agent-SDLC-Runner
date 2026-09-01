/**
 * Счёт.
 *
 * Сборка итогового документа из позиций. Порядок слагаемых значим и закреплён: подытог по
 * позициям, дальше — налоги и сборы, каждый отдельным полем, и только потом итог. Любое
 * новое слагаемое встаёт в этот порядок явно, а не «где получилось».
 */

import type { BillingConfig } from './config.ts';
import { resolveConfig } from './config.ts';
import type { Customer } from './customer.ts';
import type { Kopeck } from './money.ts';
import { subtotal } from './lines.ts';
import type { Line } from './lines.ts';

/** Выставленный счёт — так его показывают покупателю и так же проверяют в поддержке. */
export interface Invoice {
  /** Номер счёта, присваивает вызывающий. */
  number: string;
  customer: Customer;
  lines: readonly Line[];
  /** Подытог по позициям, до налогов. */
  subtotal: Kopeck;
  /** Сумма к оплате. Сейчас совпадает с подытогом: налогов в расчёте пока нет. */
  total: Kopeck;
}

/** Собрать счёт из позиций. */
export function buildInvoice(
  number: string,
  customer: Customer,
  lines: readonly Line[],
  config?: Partial<BillingConfig>,
): Invoice {
  resolveConfig(config); // конфиг читается здесь одним местом — переопределения действуют везде
  const sub = subtotal(lines);
  return { number, customer, lines, subtotal: sub, total: sub };
}
