/**
 * Точечная правка полей отчёта разведки, для которых `applyFill` не подходит: значение вне
 * меню поля (`⏭ — гейт в долге` у поля с вариантами ✅/❌), таблица, которую шаблон велит
 * удалить целиком и заменить строкой (`н/п — …`), список с отдельной строкой-альтернативой
 * (`- нет вопросов`). Диапазоны берутся из той же схемы формы (`deriveSchema`), что и у
 * `applyFill`, — второго разбора бланка здесь нет. Чистые функции.
 *
 * Концы строк: шаблоны эталона лежат с `\r\n`, и склейка своих строк через `\n` дала бы
 * файл со смешанными концами — строки собираются тем EOL, что уже стоит в тексте.
 */

import { deriveSchema, findField } from '../artifacts/formSchema.ts';
import { h2SectionRanges } from '../md/table.ts';

function splice(text: string, range: { start: number; end: number }, value: string): string {
  return text.slice(0, range.start) + value + text.slice(range.end);
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Начало нового блока markdown — строка, которую продолжением поля считать нельзя. */
const BLOCK_START = /^(\s*[-*+]\s|\s*\d+[.)]\s|#|\||\*\*|_|>|```|\s+\S)/;

/**
 * Заменяет значение поля-метки — всё после метки до конца поля, включая альтернативы после
 * `/` и НЕОТСТУПНЫЕ строки-продолжения (форма пишет «… / списки совпали /\nн/п — …», и схема
 * видит только первую строку). `null` — поля в бланке нет.
 */
export function spliceFieldValue(text: string, templateName: string, fieldId: string, value: string): string | null {
  const field = findField(deriveSchema(text, templateName), fieldId);
  if (field === undefined) return null;
  let end = field.range.end;
  for (;;) {
    const nl = text.indexOf('\n', end);
    if (nl < 0) break;
    const lineEnd = text.indexOf('\n', nl + 1);
    const line = text.slice(nl + 1, lineEnd < 0 ? text.length : lineEnd).replace(/\r$/, '');
    if (line.trim() === '' || BLOCK_START.test(line)) break;
    end = lineEnd < 0 ? text.length : lineEnd;
    if (text[end - 1] === '\r') end--;
  }
  // Строка-меню в курсиве («_Ничего подходящего не найдено: ‹да / нет›_»): закрывающий `_`
  // принадлежит разметке строки, а не значению, и остаётся на месте.
  if (text[field.range.start] === '_' && text[end - 1] === '_') end--;
  return splice(text, { start: field.valueRange.start, end }, value);
}

/**
 * Список с отдельной строкой-альтернативой («нет вопросов»): элементы есть — образец
 * заменяется ими, строка альтернативы убирается; элементов нет — образец убирается,
 * альтернатива остаётся. `null` — поля нет.
 */
export function setListField(text: string, templateName: string, fieldId: string, items: readonly string[]): string | null {
  const field = findField(deriveSchema(text, templateName), fieldId);
  if (field === undefined) return null;
  const eol = eolOf(text);
  const rendered = items.map((it) => `- ${it}`).join(eol);
  const lineRange = (r: { start: number; end: number }): { start: number; end: number } => {
    const nl = text.indexOf('\n', r.end);
    return { start: r.start, end: nl < 0 ? text.length : nl + 1 };
  };
  const edits: { start: number; end: number; value: string }[] = [];
  if (items.length === 0) {
    if (field.altRange !== undefined) edits.push({ ...lineRange(field.range), value: '' });
    else edits.push({ start: field.range.start, end: field.range.end, value: field.emptyAlternative === undefined ? '- нет' : `- ${field.emptyAlternative}` });
  } else {
    edits.push({ start: field.range.start, end: field.range.end, value: rendered });
    if (field.altRange !== undefined) edits.push({ ...lineRange(field.altRange), value: '' });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = splice(out, e, e.value);
  return out;
}

function listBounds(lines: readonly string[]): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const isItem = /^\s*[-*+]\s+/.test(lines[i]!);
    if (isItem && first === -1) first = i;
    if (isItem) last = i;
    if (!isItem && first !== -1) break;
  }
  return first === -1 ? null : { first, last };
}

/**
 * Тот же список, что и `setListField`, но найденный ПРЯМЫМ разбором строк секции, а не
 * схемой — как `replaceTableRows` рядом с `removeTableInSection`. После первого заполнения
 * список несёт реальные строки без плейсхолдера в образце, и `deriveSchema` больше не
 * регистрирует его полем (`formSchema.ts` требует плейсхолдер в строке-образце); повторный
 * проход этапа по уже заполненному отчёту иначе терял бы новые пункты молча (ревью
 * code-review-all, 2026-09-11). Секции без единой строки списка — текст без изменений.
 */
export function replaceListInSection(text: string, title: RegExp, items: readonly string[], emptyAlternative: string): string {
  const range = h2SectionRanges(text, title)[0];
  if (range === undefined) return text;
  const eol = eolOf(text);
  const lines = text.slice(range.start, range.end).split(/\r?\n/);
  const b = listBounds(lines);
  if (b === null) return text;
  const rendered = items.length === 0 ? [`- ${emptyAlternative}`] : items.map((it) => `- ${it}`);
  return splice(text, range, [...lines.slice(0, b.first), ...rendered, ...lines.slice(b.last + 1)].join(eol));
}

function tableBounds(lines: readonly string[]): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const isRow = lines[i]!.trimStart().startsWith('|');
    if (isRow && first === -1) first = i;
    if (isRow) last = i;
    if (!isRow && first !== -1) break;
  }
  return first === -1 ? null : { first, last };
}

/**
 * Удаляет markdown-таблицу (шапку, разделитель, строки) внутри секции `## title` и ставит
 * на её место `replacement` (пусто — просто удалить). Таблицы нет — текст без изменений.
 * Легенды секции остаются: форма велит удалить именно таблицу.
 */
export function removeTableInSection(text: string, title: RegExp, replacement: string): string {
  const range = h2SectionRanges(text, title)[0];
  if (range === undefined) return text;
  const eol = eolOf(text);
  const lines = text.slice(range.start, range.end).split(/\r?\n/);
  const b = tableBounds(lines);
  if (b === null) return text;
  const middle = replacement === '' ? [] : [replacement];
  return splice(text, range, [...lines.slice(0, b.first), ...middle, ...lines.slice(b.last + 1)].join(eol));
}

/** Строки данных таблицы под шапкой (без шапки и разделителя) в секции — для замены образца. */
export function replaceTableRows(text: string, title: RegExp, rows: readonly string[]): string {
  const range = h2SectionRanges(text, title)[0];
  if (range === undefined) return text;
  const eol = eolOf(text);
  const lines = text.slice(range.start, range.end).split(/\r?\n/);
  const b = tableBounds(lines);
  if (b === null) return text;
  const keep = lines.slice(b.first, b.first + 2);
  return splice(text, range, [...lines.slice(0, b.first), ...keep, ...rows, ...lines.slice(b.last + 1)].join(eol));
}
