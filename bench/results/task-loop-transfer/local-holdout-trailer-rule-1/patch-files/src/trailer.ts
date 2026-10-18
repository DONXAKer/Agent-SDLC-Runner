/**
 * Расчёт расхода топлива на поездку с прицепом.
 *
 * Прицеп — свойство поездки, а не класса автомобиля, поэтому норму класса не трогаем:
 * к ней на каждый расчёт прибавляется надбавка за прицеп. Правило — из диспетчерской:
 * надбавка фиксированная, 2 литра на 100 км, к норме класса, и расчёт ведётся по
 * скорректированной норме дальше, как обычный расход.
 *
 * Единицы: таблица норм в rates.ts записана в дл/100 км, что численно равно мл/км.
 * 2 литра на 100 км = 2000 мл / 100 км = 20 мл/км, то есть прибавке к норме класса
 * соответствует число 20 в тех же единицах, что и значения таблицы.
 */

import { rateFor } from './rates.ts';
import { FUEL_STEP_ML } from './trip.ts';

/** Надбавка за прицеп в единицах нормы (численно: 2 л/100 км = 20 мл/км). */
export const TRAILER_SURCHARGE_ML: number = 20;

/**
 * Норма класса + надбавка за прицеп; `null` — класс неизвестен.
 *
 * Помощник для вызывающего: видит итоговую норму «как для одиночной с прицепом».
 */
export function trailerRateFor(vehicleClass: string): number | null {
  const base = rateFor(vehicleClass);
  if (base === null) return null;
  return base + TRAILER_SURCHARGE_ML;
}

/**
 * Расход топлива на поездку с прицепом; `null` — класс неизвестен.
 *
 * Прицеп не меняет шаг округления: акт выдачи как и у одиночной поездки пишется
 * кратно 100 мл, шаг тот же (`FUEL_STEP_ML`), направление — вверх, в пользу парка.
 * Одиночный расход (см. trip.ts) не меняется: `fuelMl` остаётся прежней.
 */
export function trailerFuelMl(distanceKm: number, vehicleClass: string): number | null {
  const rate = trailerRateFor(vehicleClass);
  if (rate === null) return null;
  const rawMl = distanceKm * rate;
  return Math.ceil(rawMl / FUEL_STEP_ML) * FUEL_STEP_ML;
}
