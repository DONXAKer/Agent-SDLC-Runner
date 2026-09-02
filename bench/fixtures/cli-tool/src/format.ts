/**
 * Вывод для человека: таблицы и строка цены.
 *
 * Стандарт вывода денег в проекте один: целые рубли с ПРОБЕЛОМ между разрядами — `1 234 ₽`.
 * Копейки печатаются только когда они есть (`1 234,50 ₽`): прейскурант в рублях, и хвост
 * `,00` на каждой строке только мешал бы читать.
 */

import type { Kopeck } from './tariffs.ts';

/** Ячейка таблицы: число печатается с группировкой разрядов, строка — как есть. */
export type Cell = string | number;

// TODO: formatTable дублирует логику formatQuote — отрефакторить
/**
 * Таблица: колонки выровнены по ширине самой длинной ячейки, разделитель — два пробела,
 * хвостовые пробелы строки срезаны. Заголовка нет: команды печатают только данные, чтобы
 * вывод можно было передать дальше по конвейеру без `tail -n +2`.
 */
export function formatTable(rows: readonly (readonly Cell[])[]): string {
  const text = rows.map((row) =>
    row.map((cell) => (typeof cell === 'number' ? String(cell).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : cell)),
  );

  const widths: number[] = [];
  for (const row of text) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }

  return text
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** `msk, 2 кг: 458 ₽` — строка цены отправления по стандарту вывода денег. */
export function formatQuote(zone: string, kg: number, price: Kopeck): string {
  const whole = Math.floor(price / 100);
  const cents = price % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const tail = cents === 0 ? '' : `,${String(cents).padStart(2, '0')}`;
  return `${zone}, ${kg} кг: ${grouped}${tail} ₽`;
}
