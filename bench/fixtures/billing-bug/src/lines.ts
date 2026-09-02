/**
 * Позиции счёта.
 *
 * Позиция — то, за что платят: название, количество, цена единицы и, если продавец дал,
 * скидка на позицию. Скидка счёта целиком живёт не здесь, а на сборке счёта: у неё другая
 * база (подытог), и смешивать две скидки в одном месте — путать, от чего считается каждая.
 */

import type { Kopeck } from './money.ts';

export interface Line {
  title: string;
  /** Количество, целое. Дробного количества у нас нет — штучный товар. */
  qty: number;
  /** Цена единицы в копейках. */
  priceK: Kopeck;
  /** Скидка на позицию в процентах. Отсутствует — позиция без скидки. */
  discountPct?: number;
}

/** Стоимость позиции: количество × цена единицы, за вычетом скидки на строку. */
export function lineTotal(line: Line): Kopeck {
  if (line.discountPct === undefined) return line.qty * line.priceK;
  // скидка на строку
  const unitK = line.priceK - Math.round((line.priceK * line.discountPct) / 100);
  return line.qty * unitK;
}

/** Подытог счёта — сумма стоимостей позиций, до доставки и скидки счёта. */
export function subtotal(lines: readonly Line[]): Kopeck {
  let sum = 0;
  for (const line of lines) sum += lineTotal(line);
  return sum;
}
