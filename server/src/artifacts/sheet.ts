/**
 * Проводной формат «лист полей» — как модель отвечает на поле бланка и как её ответ
 * читается обратно, и компактная проекция артефакта для чтения (не для ответа).
 *
 * Зачем формат без кавычек и экранирования. Модель, отвечающая свободным текстом,
 * ломает не смысл, а РАЗМЕТКУ: не экранирует `|` в ячейке, теряет перенос строки внутри
 * многострочного поля, оставляет обе ветки меню. Здесь модель называет значение и,
 * для записей, имя колонки словом — экранирование, нумерацию `claim-N`, нормализацию
 * глифов и стирание лишней ветки меню делает рантайм при рендере (`applyFill.ts`).
 * Экранировать посимвольно тут нечего: строка распознаётся как ключ только когда её
 * начало до «:» совпадает с ожидаемым id поля/колонки (та же семантика, что у
 * `columnIndex`/`headerKey` в `md/table.ts`) — всё остальное безусловно уходит в значение.
 *
 * Разбор чистый, без I/O.
 */

import { headerKey, isSeparatorRow, splitRow } from '../md/table.ts';
import { claimStatusOf, gateStatusOf } from '../exec/normalize.ts';
import type { ChoiceOption, FormField } from './formSchema.ts';
import { splitLabelLine } from './formSchema.ts';

export type SheetValue =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; key: string; comment: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'records'; rows: Record<string, string>[] };

export interface SheetError {
  error: string;
}

const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const CONTINUATION_RE = /^\s+\S/;

/** Снимает fenced-обёртку и внешние кавычки — то, что модель добавляет «из вежливости». */
export function cleanAnswer(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  if ((text.startsWith('«') && text.endsWith('»')) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Эхо метки/id поля, которым модель предваряет ответ («- **Итог:** применено» вместо
 * «применено»), — снимается первой строкой. Живой урок: без этого метка ложилась в файл
 * ВМЕСТЕ со значением (`formFill.test.ts`, ответ на поле-строку с якорем `- **Итог:**`).
 */
function stripEcho(text: string, field: FormField): string {
  const nl = text.indexOf('\n');
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  // Разбор и срез значения идут по ОДНОЙ и той же строке без маркера списка: `valueOffset`
  // считается относительно нею, и срез по исходной строке с маркером давал сдвиг на длину
  // «- » — обрезанное значение теряло первые символы и цепляло хвост звёздочек `**`.
  const bulletStripped = firstLine.replace(/^\s*[-*+]\s+/, '').trim();
  const split = splitLabelLine(bulletStripped);
  if (split === null) return text;
  const wantedLabel = field.label ?? field.id.split('/').pop() ?? field.id;
  const norm = (s: string): string => s.trim().toLowerCase().replace(/ё/g, 'е');
  if (norm(split.label) !== norm(wantedLabel)) return text;
  const restOfFirst = bulletStripped.slice(split.valueOffset).trim();
  const rest = nl < 0 ? '' : text.slice(nl + 1);
  return restOfFirst === '' ? rest.trim() : `${restOfFirst}\n${rest}`.trim();
}

// ---------------------------------------------------------------------------
// choice
// ---------------------------------------------------------------------------

const GLYPHS = ['✅', '❌', '⏭', '⚠'] as const;

function normKey(s: string): string {
  return s
    .replace(/[`*_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

/**
 * Индекс в СЫРОМ тексте сразу после того места, где нормализованный префикс достигает
 * `prefixLen` символов, плюс любые markdown-символы сразу за ним (например, закрывающие
 * `**` у `**да**`). Совпадение находится по нормализованной строке (markdown снят,
 * пробелы схлопнуты), а резать сырой текст нужно на СВОЙ, не на нормализованный сдвиг —
 * `cut.slice(key.length)` резало по длине нормализованного ключа и оставляло обрывок
 * markdown-обвязки («да**») в значении.
 */
function rawIndexAfterNormalizedPrefix(raw: string, prefixLen: number): number {
  let normLen = 0;
  let i = 0;
  let lastWasSpace = false;
  while (i < raw.length && normLen < prefixLen) {
    const ch = raw[i]!;
    if (ch === '`' || ch === '*' || ch === '_') {
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      if (lastWasSpace) continue;
      lastWasSpace = true;
      normLen++;
      continue;
    }
    lastWasSpace = false;
    normLen++;
    i++;
  }
  while (i < raw.length && (raw[i] === '`' || raw[i] === '*' || raw[i] === '_')) i++;
  return i;
}

/** Отрезает от ответа найденный ключ и ведущий разделитель — остаток идёт в слот комментария. */
function stripKeyPrefix(text: string, key: string): string {
  const norm = normKey(text);
  const nk = normKey(key);
  let cut = text.trim();
  if (GLYPHS.includes(key as (typeof GLYPHS)[number])) {
    const at = cut.indexOf(key);
    if (at >= 0) cut = cut.slice(at + key.length);
  } else if (norm.startsWith(nk)) {
    cut = cut.slice(rawIndexAfterNormalizedPrefix(cut, nk.length)).trim();
  }
  return cut.replace(/^[\s—–:.-]+/, '').trim();
}

/**
 * Вариант меню, которому отвечает модель. Порядок узнавания: глиф → словарный ключ
 * (началом ответа) → синоним через словарь `claimStatusOf`/`gateStatusOf` (модель пишет
 * `passed`/`failed` вместо значка — тот же приём, что у `RecordClaim`) → свободный вариант,
 * если фиксированный не подошёл и свободный есть. `null` — ничего не подошло.
 */
export function matchChoice(options: readonly ChoiceOption[], raw: string): { key: string; comment: string } | null {
  const text = cleanAnswer(raw);
  if (text === '') return null;

  // Глиф, стоящий в ОТВЕТЕ последним («было ✅, теперь ❌»), а не первый по порядку в
  // константе GLYPHS: ответ моделью нередко называет прежнее состояние перед актуальным,
  // и актуальный статус — последнее упомянутое, а не то, что раньше в списке констант.
  let glyph: (typeof GLYPHS)[number] | undefined;
  let glyphAt = -1;
  for (const g of GLYPHS) {
    const at = text.lastIndexOf(g);
    if (at > glyphAt) {
      glyphAt = at;
      glyph = g;
    }
  }
  if (glyph !== undefined) {
    const opt = options.find((o) => o.key === glyph);
    if (opt !== undefined) return { key: opt.key, comment: stripKeyPrefix(text, glyph) };
  }

  const norm = normKey(text);
  for (const o of options) {
    if (o.free) continue;
    const nk = normKey(o.key);
    if (norm === nk || norm.startsWith(`${nk} `) || norm.startsWith(`${nk}—`) || norm.startsWith(`${nk}-`)) {
      return { key: o.key, comment: stripKeyPrefix(text, o.key) };
    }
  }

  const claim = claimStatusOf(norm);
  const gate = gateStatusOf(norm);
  for (const o of options) {
    if (o.free) continue;
    if (o.key === claim || o.key === gate) return { key: o.key, comment: '' };
  }

  const free = options.find((o) => o.free);
  if (free !== undefined) return { key: free.key, comment: text };
  return null;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * Строки списка из ответа. Маркер `-`/`*`/`N.` — штатная форма; модель, отдавшая просто
 * строки без маркера, тоже принимается (та же терпимость, что у `cleanRowAnswer` сегодня):
 * каждая непустая строка верхнего уровня — отдельный элемент.
 */
export function parseListItems(raw: string): string[] {
  const text = cleanAnswer(raw);
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  const bulletAt = lines.findIndex((l) => BULLET_RE.test(l));
  if (bulletAt < 0) {
    return lines.map((l) => l.trim()).filter((l) => l !== '');
  }
  const items: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (m !== null) {
      if (current !== null) items.push(current.trim());
      current = m[3] ?? '';
      continue;
    }
    if (current !== null && CONTINUATION_RE.test(line)) {
      current += ` ${line.trim()}`;
    }
  }
  if (current !== null) items.push(current.trim());
  return items.filter((i) => i !== '');
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** `- колонка: значение` внутри элемента записи. */
const FIELD_LINE_RE = /^([^:]{1,60}):\s*(.*)$/;

/**
 * Строка-шапка колонок, повторённая моделью внутри самого ответа («| id | Пункт | Как
 * проверить |»), а не строка-разделитель. `isSeparatorRow` эту строку не ловит — она не
 * состоит из дефисов, — и без отдельной проверки она попадает в результат как мусорная
 * запись листа. Ведущая колонка id/№, которую данные тоже могут нести, допускается.
 */
function looksLikeHeaderRow(cells: readonly string[], columns: readonly { header: string }[]): boolean {
  const norm = (s: string): string => s.replace(/`/g, '').trim().toLowerCase();
  const wanted = columns.map((c) => norm(c.header));
  if (wanted.length === 0) return false;
  const matches = (cs: readonly string[]): boolean =>
    cs.length > 0 && cs.every((c, i) => wanted[i] !== undefined && norm(c) === wanted[i]);
  return matches(cells) || matches(cells.slice(1));
}

function columnByKey(columns: readonly { id: string; header: string }[], raw: string): string | null {
  const want = headerKey(raw);
  const exact = columns.find((c) => c.id === want);
  if (exact !== undefined) return exact.id;
  const prefix = columns.find((c) => c.id.startsWith(want) || want.startsWith(c.id));
  return prefix === undefined ? null : prefix.id;
}

/**
 * Строки записей из ответа модели — три принимаемые формы:
 *  1. `- колонка: значение` (и продолжения на отступе) — явные имена колонок;
 *  2. `- значение1 — значение2` — позиционно, по порядку колонок (естественная форма
 *     двухколоночных образцов `- ‹путь› — ‹что меняем›`);
 *  3. `| значение1 | значение2 |` — таблица, позиционно (запасной синтаксис для моделей,
 *     которые тянутся к формату исходного бланка, как `cleanRowAnswer` сегодня).
 * Колонки `mechanical` (id, номер) в ответе не ожидаются — их нумерует рантайм.
 */
export function parseRecordRows(
  raw: string,
  columns: readonly { id: string; header: string; kind: string }[],
): Record<string, string>[] {
  const text = cleanAnswer(raw);
  if (text === '') return [];
  const modelCols = columns.filter((c) => c.kind !== 'mechanical');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');

  // Форма 3: таблица.
  if (lines.some((l) => l.trim().startsWith('|'))) {
    const rows: Record<string, string>[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('|') || isSeparatorRow(t)) continue;
      const cells = splitRow(t);
      if (looksLikeHeaderRow(cells, modelCols)) continue;
      const withoutLeadNum =
        cells.length > modelCols.length && /^\d+$|^claim-\d+$/i.test((cells[0] ?? '').replace(/`/g, '').trim())
          ? cells.slice(1)
          : cells;
      const row: Record<string, string> = {};
      modelCols.forEach((c, i) => {
        row[c.id] = (withoutLeadNum[i] ?? '').trim();
      });
      rows.push(row);
    }
    return rows;
  }

  // Формы 1 и 2: элементы списка.
  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const m = BULLET_RE.exec(line);
    if (m !== null) {
      if (current !== null) items.push(current);
      current = [(m[3] ?? '').trim()];
      continue;
    }
    if (current !== null && CONTINUATION_RE.test(line)) current.push(line.trim());
  }
  if (current !== null) items.push(current);

  return items.map((itemLines) => {
    // Форма 1: первая строка тоже может нести «колонка: значение».
    const explicit = itemLines
      .map((l) => FIELD_LINE_RE.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ label: (m[1] ?? '').trim(), value: (m[2] ?? '').trim() }));
    if (explicit.length >= Math.min(2, modelCols.length)) {
      const row: Record<string, string> = {};
      for (const e of explicit) {
        const id = columnByKey(modelCols, e.label);
        if (id !== null) row[id] = e.value;
      }
      if (Object.keys(row).length > 0) return row;
    }
    // Форма 2: позиционно по «—»/«-» на первой (единственной значимой) строке.
    const joined = itemLines.join(' ').trim();
    const parts = joined.split(/\s+[—–]\s+/);
    const row: Record<string, string> = {};
    modelCols.forEach((c, i) => {
      row[c.id] = (parts[i] ?? (modelCols.length === 1 ? joined : '')).trim();
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Разбор ответа на ОДНО поле
// ---------------------------------------------------------------------------

export function parseFieldValue(field: FormField, raw: string): SheetValue | SheetError {
  const text = stripEcho(cleanAnswer(raw), field);
  switch (field.kind) {
    case 'scalar':
    case 'multiline':
      return { kind: 'text', text };
    case 'choice': {
      const m = matchChoice(field.options ?? [], text);
      if (m === null) {
        const known = (field.options ?? []).map((o) => o.key).join(', ');
        return { error: `ответ не совпал ни с одним из вариантов поля «${field.id}»: ${known}` };
      }
      return { kind: 'choice', ...m };
    }
    case 'list':
      return { kind: 'list', items: parseListItems(text) };
    case 'records':
      return { kind: 'records', rows: parseRecordRows(text, field.columns ?? []) };
    default:
      return { error: `поле «${field.id}» не заполняется через лист полей (${field.kind})` };
  }
}

export function isSheetError(v: SheetValue | SheetError): v is SheetError {
  return 'error' in v;
}

// ---------------------------------------------------------------------------
// Компактная проекция входа — для ЧТЕНИЯ, не для ответа
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s*```/;

/**
 * Значения полей без легенд, цитат-шапок и разметки таблиц — БЕЗ ПОТЕРИ содержимого.
 * Убирается только оформление формы: строка-цитата шапки шаблона, курсивная легенда
 * секции (в том числе многострочная), разделитель таблицы `|---|---|`; строка-метка
 * `- **Метка:** значение` печатается как `метка: значение`. Прочий текст (заголовки,
 * строки таблицы, обычные пункты списка, проза) идёт без изменений: проекция не
 * фильтрует по схеме — иначе терялось бы то, что модель дописала сверх формы, а строку
 * таблицы разворачивать в запись байты не советуют (см. комментарий у разбора таблицы
 * ниже). Fenced-блок (yaml-шапка handoff'а) копируется дословно — там живут настоящие поля.
 */
export function renderSheet(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let inItalic = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    if (trimmed.startsWith('>')) continue;

    const italicWhole = /^_.*_$/.test(trimmed) || /^\*_.*_\*?$/.test(trimmed);
    if (inItalic) {
      inItalic = !/_\)?\*?$/.test(trimmed);
      continue;
    }
    if (trimmed.startsWith('_') && !italicWhole) {
      inItalic = true;
      continue;
    }
    if (italicWhole) continue;

    // Строки таблицы остаются строками. Разворот в записи `- колонка: значение` был
    // задуман против экранирования `|` и повторяющегося визуального шума — но подсчёт
    // байт показывает обратное: пока конвенция репозитория не подбивает ячейки пробелами
    // (шаблоны этого не делают), у строки `| a | b |` разметки на границу меньше, чем у
    // записи (перевод строки и отступ продолжения не бесплатны), и это верно для ЛЮБОГО
    // числа столбцов и любой длины заголовков — запись не выигрывает НИ РАЗУ ни на одном
    // реальном шаблоне (проверено прогоном по `example/`). Экономия таблицы — только
    // разделитель `|---|---|`: значений он не несёт, читающей модели не нужен вовсе.
    if (trimmed.startsWith('|')) {
      if (!isSeparatorRow(trimmed)) out.push(trimmed);
      continue;
    }

    if (trimmed === '') {
      out.push('');
      continue;
    }

    const bulletMatch = BULLET_RE.exec(raw);
    const content = bulletMatch === null ? trimmed : (bulletMatch[3] ?? '');
    const indent = bulletMatch === null ? '' : (bulletMatch[1] ?? '');
    const split = splitLabelLine(content);
    if (split !== null) {
      const value = content.slice(split.valueOffset).trim();
      out.push(`${indent}${split.label.toLowerCase().replace(/ё/g, 'е')}: ${value}`);
      continue;
    }
    out.push(raw);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
