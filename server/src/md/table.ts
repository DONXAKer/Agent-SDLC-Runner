/**
 * Разбор markdown-таблиц артефактов.
 *
 * Формы методологии держат почти все машиночитаемые данные в таблицах: набор гейтов,
 * долг, пункты приёмки, неприменимость. Один разборщик на всех — потому что три
 * независимых успели разойтись в мелочах (экранированная черта, строка-разделитель,
 * шапка как строка данных), и каждое расхождение стоило ложного статуса.
 */

export interface MdTable {
  /** Ближайший предшествующий заголовок без решёток. Пусто, если таблица до заголовков. */
  section: string;
  header: string[];
  rows: string[][];
}

/** Строка в ячейки. Вертикальная черта внутри значения экранируется как `\|`. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

const SEPARATOR = /^\|?[\s:|-]+\|[\s:|-]*$/;

export function parseTables(text: string): MdTable[] {
  const out: MdTable[] = [];
  let section = '';
  let current: MdTable | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = heading[1]!.trim();
      current = null;
      continue;
    }

    if (!line.startsWith('|')) {
      // Пустая строка или проза заканчивают таблицу: две таблицы подряд в одной секции
      // не должны слипаться в одну (в отчёте приёмки их там три).
      current = null;
      continue;
    }

    if (SEPARATOR.test(line)) continue;

    const cells = splitRow(line);
    if (current === null) {
      current = { section, header: cells, rows: [] };
      out.push(current);
      continue;
    }
    current.rows.push(cells);
  }

  return out;
}

/** Индекс колонки по началу её имени. `-1`, если такой колонки нет. */
export function columnIndex(header: readonly string[], name: string): number {
  const want = name.toLowerCase().replace(/ё/g, 'е');
  return header.findIndex((h) => h.toLowerCase().replace(/ё/g, 'е').startsWith(want));
}
