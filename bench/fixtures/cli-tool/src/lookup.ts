/**
 * Быстрая справка по цене одной строкой.
 *
 * Исторический быстрый вывод для внутренних отчётов: строка собиралась здесь ещё до того,
 * как появился общий форматтер в format.ts, и с тех пор не трогалась — на неё смотрят
 * ежедневные выгрузки поддержки.
 */

import { priceFor } from './tariffs.ts';
import type { Zone } from './tariffs.ts';

/** `msk, 2 кг: 458 ₽` — цена отправления зоны и веса. */
export function quoteLine(zone: Zone, kg: number): string {
  const price = priceFor(zone, kg);
  const rubles = Math.floor(price / 100);
  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${zone}, ${kg} кг: ${grouped} ₽`;
}
