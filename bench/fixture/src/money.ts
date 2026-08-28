/**
 * Деньги.
 *
 * Всё внутри считается в КОПЕЙКАХ целым числом. Рубли с плавающей точкой в расчёте цены
 * не появляются нигде: 0.1 + 0.2 в двоичной дроби не равно 0.3, и на длинной цепочке
 * «база → надбавка → скидка» это вылезает расхождением в копейку.
 */

/** Целое число копеек. */
export type Kopeck = number;

/** Рубли (может быть дробным) → копейки. */
export function rub(amount: number): Kopeck {
  return Math.round(amount * 100);
}

/** Сумма нескольких величин. */
export function add(...parts: Kopeck[]): Kopeck {
  let total = 0;
  for (const p of parts) total += p;
  return total;
}

/** Разность, не уходящая ниже нуля: скидка не может сделать доставку платной наоборот. */
export function subtract(amount: Kopeck, taken: Kopeck): Kopeck {
  const left = amount - taken;
  return left < 0 ? 0 : left;
}

/**
 * Процент от суммы с округлением ПОЛОВИНЫ ВВЕРХ.
 *
 * Math.round() округляет −0.5 к нулю, а не вверх, но суммы здесь неотрицательные, и
 * важнее другое: правило округления у нас одно на весь расчёт. Свой round в соседнем
 * модуле — это расхождение в копейку на каждой второй строке тарифа.
 */
export function percent(amount: Kopeck, pct: number): Kopeck {
  return Math.floor((amount * pct) / 100 + 0.5);
}

/** «1 234,56 ₽» — пробел между разрядами, запятая перед копейками. */
export function formatRub(amount: Kopeck): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const groups = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${groups},${String(cents).padStart(2, '0')} ₽`;
}
