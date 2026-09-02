/**
 * Счёт.
 *
 * Сборка итогового документа из позиций. Порядок слагаемых значим и закреплён: подытог по
 * позициям, доставка, скидка счёта — и только потом итог. Любое новое слагаемое встаёт в
 * этот порядок явно, а не «где получилось».
 */

import type { Kopeck } from './money.ts';
import { percent } from './money.ts';
import { subtotal } from './lines.ts';
import type { Line } from './lines.ts';

/** Выставленный счёт — так его показывают покупателю и так же проверяют в поддержке. */
export interface Invoice {
  /** Номер счёта, присваивает вызывающий. */
  number: string;
  lines: readonly Line[];
  /** Стоимость доставки в копейках; самовывоз — 0. */
  deliveryK: Kopeck;
  /** Скидка счёта в процентах; 0 — без скидки. */
  discountPct: number;
  /** Подытог по позициям, до доставки и скидки. */
  subtotal: Kopeck;
  /** Сумма к оплате. */
  total: Kopeck;
}

/** Собрать счёт из позиций, доставки и скидки. */
export function buildInvoice(
  number: string,
  lines: readonly Line[],
  deliveryK: Kopeck,
  discountPct: number,
): Invoice {
  const sub = subtotal(lines);
  const gross = sub + deliveryK;
  const discount = percent(gross, discountPct);
  const total = gross - discount;
  return { number, lines, deliveryK, discountPct, subtotal: sub, total };
}
