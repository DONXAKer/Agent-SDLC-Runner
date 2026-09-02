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

/** Строка-разделитель `|---|---|` (замыкающая черта необязательна — модели её теряют). */
export function isSeparatorRow(line: string): boolean {
  return SEPARATOR.test(line.trim());
}

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

    if (isSeparatorRow(line)) continue;

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

/** Экранирование `|` в значении ячейки — обратная сторона `splitRow`, один на всех. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * Диапазоны h2-секций, чей заголовок матчит `title`. Секцию закрывает только следующий
 * h2 (или конец файла) — подзаголовки h3/h4 остаются внутри. Отдельно от `section` у
 * `parseTables`: тот сбрасывается на заголовке ЛЮБОГО уровня, и таблица под «### …»
 * внутри нужной секции выпадала бы из выборки (пойман ревью-3 на карте кодовой базы).
 */
export function h2SectionRanges(text: string, title: RegExp): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const h2 = /^##\s+(.+)$/gm;
  let open: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = h2.exec(text)) !== null) {
    if (open !== null) {
      out.push({ start: open, end: m.index });
      open = null;
    }
    if (title.test(m[1]!)) open = m.index;
  }
  if (open !== null) out.push({ start: open, end: text.length });
  return out;
}

/** Индекс колонки по началу её имени. `-1`, если такой колонки нет. */
export function columnIndex(header: readonly string[], name: string): number {
  const want = name.toLowerCase().replace(/ё/g, 'е');
  return header.findIndex((h) => h.toLowerCase().replace(/ё/g, 'е').startsWith(want));
}

/**
 * Ключ колонки по её заголовку: текст до первой скобки, без обратных кавычек и лишних
 * пробелов, в нижнем регистре с `ё→е`. «Как проверить (процедура + критерий)» и
 * «Как проверить» — одна колонка; тем же правилом сопоставляются ключи в ответе модели
 * (`artifacts/sheet.ts`) и колонки схемы формы (`artifacts/formSchema.ts`).
 */
export function headerKey(header: string): string {
  return header
    .replace(/`/g, '')
    .replace(/\s*\(.*$/, '')
    .replace(/\*\*/g, '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}
