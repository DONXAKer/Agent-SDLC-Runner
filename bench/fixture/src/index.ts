/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { add, formatRub, percent, rub, subtract } from './money.ts';
export type { Kopeck } from './money.ts';

export { ANONYMOUS, applyDiscount, discountFor } from './discounts.ts';
export type { Customer, Tier } from './discounts.ts';

export { ZONES, zoneOf } from './zones.ts';
export type { Zone } from './zones.ts';

export {
  TARIFF_TABLE,
  WEIGHT_STEPS,
  basePrice,
  dimensionSum,
  longestSide,
  priceFor,
  weightStep,
} from './tariffs.ts';
export type { Dimensions, Order, Quote } from './tariffs.ts';

import { priceFor } from './tariffs.ts';
import type { Order, Quote } from './tariffs.ts';

/** Точка входа для вызывающих: посчитать цену отправления. */
export function quote(order: Order): Quote {
  return priceFor(order);
}
