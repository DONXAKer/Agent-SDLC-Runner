/**
 * Разбор markdown артефактов, промптов и ответа модели в дерево для показа на дашборде.
 *
 * Своя маленькая грамматика, а не библиотека: рисуется React-элементами, без `innerHTML`, —
 * текст пишет модель, и HTML из него в страницу не попадает по построению. Покрыто то, из
 * чего состоят артефакты методологии: заголовки, таблицы (с `\|` из `applyFill`), списки с
 * чек-боксами, код, цитаты, комментарии-подсказки шаблонов. Мягкий перенос строки
 * сохраняется: в артефактах строка значима, а склейка в абзац прятала бы структуру.
 */

import { splitRow } from '@sdlc-runner/shared';

export { splitRow };

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'ph'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; c: Inline[]; href: string };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  depth: number;
  /** Номер пункта нумерованного списка; `null` — маркированный. */
  num: string | null;
  /** Чек-бокс `[ ]`/`[x]`; `null` — его нет. */
  checked: boolean | null;
  text: Inline[];
}

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  /** Код с языком markdown — модели заворачивают в него весь ответ; рисуется разобранным. */
  | { t: 'nested'; blocks: Block[] }
  | { t: 'list'; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'comment'; v: string }
  | { t: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const CHECK = /^\[( |x|X)\]\s+/;
const QUOTE = /^ {0,3}>\s?/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const MARKDOWN_LANGS = new Set(['markdown', 'md']);

function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
}

/**
 * `_курсив_` — только на границе слова: `files_to_touch` и `chunk_1_attempt` в артефактах
 * встречаются чаще подчёркивания ради выделения. Код в обратных кавычках может переноситься
 * на следующую строку абзаца: иначе кавычки спаривались через одну и код «выворачивался».
 */
const INLINE =
  /`([^`]+?)`|\*\*(?=\S)([\s\S]+?)\*\*|~~(?=\S)([\s\S]+?)~~|\*(?=[^\s*])([\s\S]+?)\*|(?<![\p{L}\p{N}_])_(?=\S)([^_\n]+?)_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\(([^)\s]+)\)|(‹[^›\n]*›)/gu;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (v: string): void => {
    if (v === '') return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };
  let pos = 0;
  for (const m of src.matchAll(INLINE)) {
    text(src.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', c: parseInline(m[2]) });
    else if (m[3] !== undefined) out.push({ t: 'del', c: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ t: 'em', c: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ t: 'em', c: parseInline(m[5]) });
    else if (m[6] !== undefined && m[7] !== undefined) out.push({ t: 'link', c: parseInline(m[6]), href: m[7] });
    else if (m[8] !== undefined) out.push({ t: 'ph', v: m[8] });
  }
  text(src.slice(pos));
  return out;
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && next.includes('-') && TABLE_SEP.test(next);
}

/**
 * Продолжает ли строка тело уже открытой таблицы: непустая и либо начинается/кончается
 * чертой, либо реально делится на больше одной ячейки (`splitRow` уже не считает `|`
 * внутри `` ` `` разделителем — прозу вроде «пример: `a | b`» это не заденет).
 */
function looksLikeTableRow(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  return t.startsWith('|') || (t.endsWith('|') && !t.endsWith('\\|')) || splitRow(line).length > 1;
}

/** Начинает ли строка блок, прерывающий абзац. */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    LIST.test(line) ||
    QUOTE.test(line) ||
    line.trimStart().startsWith('<!--') ||
    isTableStart(line, next)
  );
}

/**
 * `topLevel` — рисуется ли `src` как целый документ (артефакт-файл) или как фрагмент
 * (текст промпта, ответ модели): шапка `---…---` в начале — YAML-фронтматтер файла;
 * то же самое в начале фрагмента — совпадение (промпт часто начинается с горизонтальной
 * черты-разделителя между разделами, `prompt/build.ts` пишет её ровно так) и НЕ фронтматтер.
 * Умолчание — целый документ, единственный прежний смысл вызова без второго аргумента.
 */
export function parseMarkdown(src: string, topLevel = true): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'), topLevel);
}

function parseLines(lines: string[], top: boolean): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  // Шапка YAML в начале файла — показывается кодом, а не горизонтальными чертами.
  if (top && lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (end > 0) {
      blocks.push({ t: 'code', lang: 'yaml', v: lines.slice(1, end).join('\n') });
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const mark = fence[1]!;
      const lang = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!.trim();
        // Закрывает черта того же символа и не короче открывающей.
        if (l.length >= mark.length && l.split('').every((ch) => ch === mark[0])) break;
        body.push(lines[i]!);
        i++;
      }
      i++; // закрывающая черта (или конец текста у незакрытого блока)
      blocks.push(MARKDOWN_LANGS.has(lang) ? { t: 'nested', blocks: parseLines(body, false) } : { t: 'code', lang, v: body.join('\n') });
      continue;
    }

    if (line.trimStart().startsWith('<!--')) {
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        body.push(l);
        i++;
        if (l.includes('-->')) break;
      }
      const v = body.join('\n').replace(/^\s*<!--/, '').replace(/-->\s*$/, '').trim();
      blocks.push({ t: 'comment', v });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ t: 'heading', level: heading[1]!.length, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(QUOTE, ''));
        i++;
      }
      blocks.push({ t: 'quote', blocks: parseLines(body, false) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      // Тело таблицы кончается на первой строке, не похожей на строку таблицы: голое
      // `line.includes('|')` цепляло прозу сразу ПОСЛЕ настоящей таблицы, где `|` есть, но
      // только внутри `` `кода` `` (splitRow его не считает разделителем — та же строка
      // делится на ОДНУ ячейку) — например, пример шелл-пайпа в обратных кавычках.
      while (i < lines.length && looksLikeTableRow(lines[i]!)) {
        const cells = splitRow(lines[i]!);
        // Недостающие ячейки дополняются: строка короче шапки не должна сдвигать колонки.
        while (cells.length < head.length) cells.push('');
        rows.push(cells.map(parseInline));
        i++;
      }
      blocks.push({ t: 'table', head: head.map(parseInline), align, rows });
      continue;
    }

    if (LIST.test(line)) {
      const items: ListItem[] = [];
      const indents: number[] = [];
      let raw: string[] = [];
      const flush = (): void => {
        const last = items[items.length - 1];
        if (last !== undefined && raw.length > 0) last.text = parseInline(raw.join('\n'));
        raw = [];
      };
      while (i < lines.length) {
        const l = lines[i]!;
        const m = LIST.exec(l);
        if (m !== null && !HR.test(l)) {
          flush();
          const indent = m[1]!.replace(/\t/g, '    ').length;
          while (indents.length > 0 && indents[indents.length - 1]! > indent) indents.pop();
          if (indents.length === 0 || indents[indents.length - 1]! < indent) indents.push(indent);
          const marker = m[2]!;
          let body = m[3] ?? '';
          const check = CHECK.exec(body);
          if (check !== null) body = body.slice(check[0].length);
          items.push({
            depth: indents.length - 1,
            num: /\d/.test(marker) ? marker.slice(0, -1) : null,
            checked: check === null ? null : check[1] !== ' ',
            text: [],
          });
          raw.push(body);
          i++;
          continue;
        }
        if (l.trim() === '') {
          // Пустая строка внутри списка его не рвёт, если следом снова пункт.
          const after = lines[i + 1];
          if (after !== undefined && LIST.test(after) && !HR.test(after)) {
            i++;
            continue;
          }
          break;
        }
        // Продолжение пункта — строка с отступом; без отступа — конец списка.
        if (/^\s/.test(l) && !startsBlock(l.trimStart(), lines[i + 1])) {
          raw.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      flush();
      blocks.push({ t: 'list', items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === '') break;
      if (para.length > 0 && startsBlock(l, lines[i + 1])) break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ t: 'para', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

/** Показывать ли файл как markdown по умолчанию. */
export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}
