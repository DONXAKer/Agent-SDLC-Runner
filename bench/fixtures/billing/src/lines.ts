/**
 * Позиции счёта.
 *
 * Позиция — то, за что платят: название, количество, цена единицы. Скидок и налогов здесь
 * нет намеренно: они применяются к счёту целиком на сборке, а не к строкам — иначе итог
 * перестаёт сходиться с подытогом на округлениях каждой строки.
 */

import type { Kopeck } from './money.ts';

export interface Line {
  title: string;
  /** Количество, целое. Дробного количества у нас нет — штучный товар. */
  qty: number;
  /** Цена единицы в копейках. */
  priceK: Kopeck;
}

/** Стоимость позиции: количество × цена единицы. */
export function lineTotal(line: Line): Kopeck {
  return line.qty * line.priceK;
}

/** Подытог счёта — сумма по позициям, до всяких налогов. */
export function subtotal(lines: readonly Line[]): Kopeck {
  let sum = 0;
  for (const line of lines) sum += lineTotal(line);
  return sum;
}
