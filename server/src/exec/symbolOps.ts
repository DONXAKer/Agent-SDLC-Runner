/**
 * Операции этапа chunk над символами: модель называет символ из показанной карточки и
 * новое содержимое, а позицию объявления в файле и совпадение с исходником материализует
 * рантайм. Байт-точных SEARCH-фрагментов в протоколе больше нет (см. guided.md,
 * «Операции этапа chunk»).
 *
 * Разбор объявлений — лёгкий сканер (не полный парсер TS): комментарии, строки и
 * шаблонные литералы пропускаются, поэтому границы объявлений не съезжают на коде внутри
 * строк. Неоднозначность имени — отказ с кандидатами (qualified-имена вида `Class.method`),
 * а не угадывание.
 */

import { z } from 'zod';

export const symbolNameSchema = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u, 'Точное имя символа из карточки');

const file = z.string().min(1);
export const SymbolOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_body'), file, symbol: symbolNameSchema, body: z.string().min(1) }).strict(),
  z.object({ op: z.literal('insert_after'), file, anchor: symbolNameSchema, body: z.string().min(1) }).strict(),
  z.object({ op: z.literal('insert_before'), file, anchor: symbolNameSchema, body: z.string().min(1) }).strict(),
  z.object({ op: z.literal('rename'), file, symbol: symbolNameSchema, newName: z.string().regex(/^[A-Za-z_$][\w$]*$/u) }).strict(),
  z.object({ op: z.literal('delete'), file, symbol: symbolNameSchema }).strict(),
  z.object({ op: z.literal('create_file'), file, body: z.string().min(1) }).strict(),
  z.object({ op: z.literal('ensure_import'), file, from: z.string().min(1), names: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/u)).min(1).max(40) }).strict(),
  z.object({ op: z.literal('ensure_reexport'), file, from: z.string().min(1), names: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/u)).min(1).max(40) }).strict(),
]);
export type SymbolOp = z.infer<typeof SymbolOp>;

export interface OpDiagnostic {
  kind: 'unknown_symbol' | 'ambiguous_symbol' | 'not_new_file' | 'file_outside_group' | 'syntax' | 'rename_conflict' | 'missing_declaration';
  op: string;
  file: string;
  symbol?: string;
  candidates: string[];
  snippet?: string;
}
export class GuidedOpError extends Error {
  readonly diagnostic: OpDiagnostic;
  constructor(message: string, diagnostic: OpDiagnostic) { super(message); this.diagnostic = diagnostic; }
}

export interface SymbolDecl {
  /** Простое имя (`method` у `Class.method`). */
  name: string;
  /** Квалифицированное имя: `name` на верхнем уровне, `Class.name` у членов класса. */
  qualified: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'method' | 'property';
  exported: boolean;
  /** Диапазон всего объявления, включая `export`/декораторы и предшествующий jsdoc. */
  start: number;
  end: number;
  /** Для объявлений с телом в фигурных скобках — границы внутри них. */
  bodyStart: number | null;
  bodyEnd: number | null;
}

interface ScanState { depth: number; classStack: { name: string; depth: number }[]; }

/** Идёт по исходнику, пропуская строки/комментарии/шаблоны; вызывает cb по значимым позициям. */
function* codePositions(source: string): Generator<{ index: number; char: string }> {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') { const end = source.indexOf('\n', i); i = end < 0 ? n : end; continue; }
    if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          // Вложенное выражение шаблона — обычный код: отдать его наружу.
          let depth = 1; i += 2;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            else if (source[i] === '`') { /* вложенный шаблон пропускаем грубо */ }
            i++;
          }
          continue;
        }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    yield { index: i, char: c };
    i++;
  }
}

const IDENT = /[A-Za-z_$][\w$]*/yu;
const MODIFIERS = new Set(['export', 'default', 'declare', 'abstract', 'async', 'public', 'private', 'protected', 'static', 'readonly', 'override']);
const DECL_KEYWORDS = new Set(['function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var']);

/** Токены кода (идентификаторы, ключевые слова, знаки) без строк и комментариев. */
function tokens(source: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let lastIndex = 0;
  let boundary = true;
  let skipUntil = 0;
  for (const pos of codePositions(source)) {
    const { index, char } = pos;
    if (index < skipUntil) continue; // остаток уже захваченного идентификатора
    if (/\s/u.test(char)) { boundary = true; lastIndex = index + 1; continue; }
    IDENT.lastIndex = index;
    const match = boundary ? IDENT.exec(source) : null;
    if (match && match.index === index) {
      out.push({ text: match[0], index });
      lastIndex = index + match[0].length;
      skipUntil = lastIndex;
      boundary = false;
      continue;
    }
    out.push({ text: char, index });
    boundary = /[{}()[\];,.<>:=?&|!+\-*/@#]/u.test(char);
    lastIndex = index + 1;
  }
  return out;
}

function matchBrace(source: string, openIndex: number): number | null {
  let depth = 0;
  for (const pos of codePositions(source)) {
    if (pos.index < openIndex) continue;
    if (pos.char === '{') depth++;
    else if (pos.char === '}') { depth--; if (depth === 0) return pos.index; }
  }
  return null;
}

/** Вернуться через предшествующие декораторы и jsdoc-комментарий, примыкающие к объявлению. */
function declStartWithTrivia(source: string, start: number): number {
  let s = start;
  for (;;) {
    const before = source.slice(0, s);
    const jsdoc = /\/\*\*[\s\S]*?\*\/\s*$/u.exec(before);
    if (jsdoc && !/[^\s]/u.test(before.slice(jsdoc.index + jsdoc[0].length))) { s = jsdoc.index; continue; }
    const line = before.slice(before.lastIndexOf('\n') + 1);
    if (/^\s*$/u.test(line)) {
      const prevLineEnd = before.lastIndexOf('\n');
      if (prevLineEnd < 0) break;
      const prevStart = before.lastIndexOf('\n', prevLineEnd - 1) + 1;
      const prevLine = before.slice(prevStart, prevLineEnd);
      if (/^\s*@[\w$]+(?:\([^)]*\))?\s*$/u.test(prevLine)) { s = prevStart; continue; }
    }
    break;
  }
  return s;
}

/** Объявления символов верхнего уровня и члены классов. */
export function findSymbols(source: string): SymbolDecl[] {
  const tk = tokens(source);
  const out: SymbolDecl[] = [];
  const state: ScanState = { depth: 0, classStack: [] };
  let i = 0;
  let exported = false;
  let declTrivia = 0;
  const peek = (offset: number): string | undefined => tk[i + offset]?.text;
  while (i < tk.length) {
    const t = tk[i]!;
    if (t.text === '{') {
      state.depth++;
      if (state.classStack.length && state.classStack.at(-1)!.depth === -1) state.classStack.at(-1)!.depth = state.depth;
      i++; continue;
    }
    if (t.text === '}') {
      if (state.classStack.length && state.classStack.at(-1)!.depth === state.depth) state.classStack.pop();
      state.depth--; i++; exported = false; continue;
    }
    if (t.text === 'export' || t.text === 'default') { if (t.text === 'export') { exported = true; declTrivia = declStartWithTrivia(source, t.index); } i++; continue; }
    const inClass = state.classStack.length > 0 && state.classStack.at(-1)!.depth > 0 && state.depth === state.classStack.at(-1)!.depth;
    if (MODIFIERS.has(t.text)) { i++; continue; }
    // Объявления верхнего уровня — только на нулевой глубине: вложенная функция в теле
    // другой функции не является адресуемым символом карточки.
    if (!inClass && state.depth === 0 && DECL_KEYWORDS.has(t.text)) {
      const keyword = t.text;
      const nameToken = tk[i + 1];
      if (!nameToken || !/^[A-Za-z_$][\w$]*$/u.test(nameToken.text)) { i++; continue; }
      const name = nameToken.text;
      let end: number;
      let bodyStart: number | null = null;
      let bodyEnd: number | null = null;
      if (keyword === 'type') {
        let j = i + 2; let semi: number | null = null; let localDepth = 0;
        for (let k = j; k < tk.length; k++) {
          const tt = tk[k]!.text;
          if (tt === '{' || tt === '(' || tt === '[') localDepth++;
          else if (tt === '}' || tt === ')' || tt === ']') localDepth--;
          else if (tt === ';' && localDepth === 0) { semi = tk[k]!.index; break; }
          else if ((tt === 'export' || DECL_KEYWORDS.has(tt)) && localDepth === 0 && k > j) break;
        }
        end = semi === null ? nameToken.index + name.length : semi + 1;
      } else if (keyword === 'const' || keyword === 'let' || keyword === 'var') {
        let localDepth = 0; let semi: number | null = null;
        for (let k = i + 2; k < tk.length; k++) {
          const tt = tk[k]!.text;
          if (tt === '{' || tt === '(' || tt === '[') localDepth++;
          else if (tt === '}' || tt === ')' || tt === ']') localDepth--;
          else if (tt === ';' && localDepth === 0) { semi = tk[k]!.index; break; }
          else if (tt === ',' && localDepth === 0) { semi = tk[k]!.index; break; } // первое имя объявления
        }
        end = (semi === null ? nameToken.index + name.length : semi + 1);
        if (source[end - 1] === ',') end--;
      } else {
        // function/class/interface/enum: до парной закрывающей скобки тела.
        let openIndex = -1;
        for (let k = i + 2; k < tk.length; k++) {
          if (tk[k]!.text === '{') { openIndex = tk[k]!.index; break; }
          if (tk[k]!.text === ';') break;
        }
        if (openIndex < 0) { i++; continue; }
        const close = matchBrace(source, openIndex);
        if (close === null) { i++; continue; }
        end = close + 1;
        bodyStart = openIndex + 1; bodyEnd = close;
        if (keyword === 'class') state.classStack.push({ name, depth: -1 });
      }
      out.push({ name, qualified: name, kind: keyword === 'function' ? 'function' : keyword === 'class' ? 'class' :
        keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'type' ? 'type' : 'variable',
        exported, start: exported ? Math.min(declTrivia, t.index) : declStartWithTrivia(source, t.index), end, bodyStart, bodyEnd });
      exported = false;
      i += 2;
      continue;
    }
    if (inClass && /^[A-Za-z_$][\w$]*$/u.test(t.text) && peek(1) === '(' && !new Set(['if', 'for', 'while', 'switch', 'return', 'catch']).has(t.text)) {
      const className = state.classStack.at(-1)!.name;
      let openIndex = -1;
      for (let k = i + 1; k < tk.length; k++) { if (tk[k]!.text === '{') { openIndex = tk[k]!.index; break; } if (tk[k]!.text === ';') break; }
      if (openIndex >= 0) {
        const close = matchBrace(source, openIndex);
        if (close !== null) {
          out.push({ name: t.text, qualified: `${className}.${t.text}`, kind: 'method', exported,
            start: declStartWithTrivia(source, t.index), end: close + 1, bodyStart: openIndex + 1, bodyEnd: close });
        }
      }
    }
    i++;
  }
  return out;
}

export type ResolveResult = { ok: true; decl: SymbolDecl } | { ok: false; ambiguous: boolean; candidates: string[] };

/** Точное совпадение имени; неоднозначность возвращает qualified-кандидатов. */
export function resolveSymbol(decls: readonly SymbolDecl[], name: string): ResolveResult {
  const matches = decls.filter(d => d.qualified === name || (!name.includes('.') && d.name === name));
  if (matches.length === 1) return { ok: true, decl: matches[0]! };
  const candidates = (matches.length > 1 ? matches.map(d => d.qualified) : [...new Set(decls.map(d => d.qualified))]).slice(0, 20);
  return { ok: false, ambiguous: matches.length > 1, candidates };
}

const identifierRe = (name: string): RegExp => new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'gu');

/** Позиции идентификатора вне строк и комментариев. */
export function identifierOccurrences(source: string, name: string): number[] {
  const re = identifierRe(name);
  const out: number[] = [];
  for (const pos of codePositions(source)) {
    re.lastIndex = pos.index;
    const match = re.exec(source);
    if (match && match.index === pos.index) out.push(pos.index);
  }
  return out;
}

export function renameIdentifier(source: string, name: string, newName: string): string {
  const positions = identifierOccurrences(source, name);
  let out = '';
  let last = 0;
  for (const at of positions) { out += source.slice(last, at) + newName; last = at + name.length; }
  return out + source.slice(last);
}

/** ensure_import: слить имена с существующим импортом из того же модуля или вставить новый. */
export function ensureImport(source: string, from: string, names: readonly string[]): string {
  const wanted = [...new Set(names)];
  const importRe = /^[ \t]*import\s+(type\s+)?(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gmu;
  for (const match of source.matchAll(importRe)) {
    if (match[4] !== from) continue;
    const existing = match[3]!.split(',').map(n => n.trim()).filter(Boolean);
    const missing = wanted.filter(n => !existing.includes(n) && !existing.includes(`type ${n}`));
    if (missing.length === 0) return source;
    const merged = [...existing, ...missing].join(', ');
    const replacement = match[0].replace(/\{[^}]*\}/u, `{ ${merged} }`);
    return source.slice(0, match.index) + replacement + source.slice(match.index! + match[0].length);
  }
  const line = `import { ${wanted.join(', ')} } from '${from}';`;
  const lines = source.split('\n');
  let lastImport = -1;
  for (const [index, value] of lines.entries()) {
    if (/^\s*import\s/u.test(value)) lastImport = index;
    else if (value.trim() !== '' && !/^\s*\/\//u.test(value) && !/^\s*\/\*/u.test(value) && !/^\s*\*/u.test(value) && lastImport >= 0) break;
  }
  if (lastImport >= 0) lines.splice(lastImport + 1, 0, line);
  else {
    let at = 0;
    while (at < lines.length && (/^\s*(\/\/|\/\*|\*|\*\/)/u.test(lines[at]!) || lines[at]!.trim() === '')) at++;
    lines.splice(at, 0, line);
  }
  return lines.join('\n');
}

/** ensure_reexport: слить имена с существующим re-export из того же модуля или вставить новый. */
export function ensureReexport(source: string, from: string, names: readonly string[]): string {
  const wanted = [...new Set(names)];
  const reexportRe = /^[ \t]*export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gmu;
  for (const match of source.matchAll(reexportRe)) {
    if (match[2] !== from) continue;
    const existing = match[1]!.split(',').map(n => n.trim()).filter(Boolean);
    const missing = wanted.filter(n => !existing.includes(n));
    if (missing.length === 0) return source;
    const merged = [...existing, ...missing].join(', ');
    const replacement = match[0].replace(/\{[^}]*\}/u, `{ ${merged} }`);
    return source.slice(0, match.index) + replacement + source.slice(match.index! + match[0].length);
  }
  const line = `export { ${wanted.join(', ')} } from '${from}';`;
  const lines = source.split('\n');
  let lastExport = -1;
  for (const [index, value] of lines.entries()) {
    if (/^\s*export\s/u.test(value)) lastExport = index;
    else if (value.trim() !== '' && !/^\s*\/\//u.test(value) && !/^\s*\/\*/u.test(value) && !/^\s*\*/u.test(value) && lastExport >= 0) break;
  }
  if (lastExport >= 0) lines.splice(lastExport + 1, 0, line);
  else {
    let at = 0;
    while (at < lines.length && (/^\s*(\/\/|\/\*|\*|\*\/)/u.test(lines[at]!) || lines[at]!.trim() === '')) at++;
    lines.splice(at, 0, line);
  }
  return lines.join('\n');
}

const declaresSymbol = (body: string, name: string): boolean =>
  new RegExp(`(?:^|[\\s{;])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${name.replace(/\$/gu, '\\$')}\\b`, 'u').test(body) ||
  new RegExp(`^\\s*(?:async\\s+)?(?:static\\s+)?(?:get\\s+|set\\s+)?${name.replace(/\$/gu, '\\$')}\\s*[(<]`, 'mu').test(body);

export interface AppliedFile { before: string | null; after: string; }

function fail(kind: OpDiagnostic['kind'], op: SymbolOp, message: string, extra: Partial<OpDiagnostic> = {}): never {
  const file = op.file;
  const symbol = 'symbol' in op ? op.symbol : 'anchor' in op ? op.anchor : undefined;
  throw new GuidedOpError(message, { kind, op: op.op, file, ...(symbol === undefined ? {} : { symbol }), candidates: [], ...extra });
}

/**
 * Применить одну операцию к тексту файла. `before === null` — файл отсутствует.
 * Никаких записей на диск: только текстовая трансформация с проверками.
 */
export function applySymbolOp(before: string | null, op: SymbolOp): string {
  if (op.op === 'create_file') {
    if (before !== null) fail('not_new_file', op, `create_file: ${op.file} уже существует; используй операции над символами`);
    return op.body.replace(/\r\n/gu, '\n').trimEnd() + '\n';
  }
  if (before === null) fail('missing_declaration', op, `${op.op}: файл ${op.file} не существует; новый файл создаётся только через create_file`);
  if (op.op === 'ensure_import') return ensureImport(before, op.from, op.names);
  if (op.op === 'ensure_reexport') return ensureReexport(before, op.from, op.names);
  const decls = findSymbols(before);
  const targetName = op.op === 'insert_after' || op.op === 'insert_before' ? op.anchor : op.symbol;
  const resolved = resolveSymbol(decls, targetName);
  if (!resolved.ok) {
    const snippet = before.split('\n').slice(0, 40).map((line, index) => `${index + 1}: ${line}`).join('\n').slice(0, 2000);
    fail(resolved.ambiguous ? 'ambiguous_symbol' : 'unknown_symbol', op,
      resolved.ambiguous
        ? `${op.op}: имя ${targetName} неоднозначно в ${op.file}; уточни qualified-имя: ${resolved.candidates.join(', ')}`
        : `${op.op}: символ ${targetName} не найден в ${op.file}. Доступные символы: ${resolved.candidates.join(', ') || '(объявлений не найдено)'}`,
      { candidates: resolved.candidates, snippet });
  }
  const decl = resolved.decl;
  switch (op.op) {
    case 'replace_body': {
      if (declaresSymbol(op.body, decl.name)) {
        return before.slice(0, decl.start) + op.body.replace(/\r\n/gu, '\n').replace(/\s+$/u, '') + before.slice(decl.end);
      }
      if (decl.bodyStart === null || decl.bodyEnd === null) {
        fail('missing_declaration', op,
          `replace_body: ${op.symbol} не имеет тела в фигурных скобках; верни полное объявление символа в body`,
          { candidates: decls.filter(d => d.qualified === decl.qualified).map(d => d.qualified) });
      }
      const body = op.body.replace(/\r\n/gu, '\n').replace(/^\n+|\s+$/gu, '');
      const indent = /(?:^|\n)([ \t]*)\S/u.exec(before.slice(decl.bodyStart, decl.bodyEnd))?.[1] ?? '  ';
      const indented = body.split('\n').map(line => line.trim() === '' ? '' : `${indent}${line}`).join('\n');
      // Отступ закрывающей скобки: её строка либо уже несёт отступ перед `}`, либо
      // (тело было на одной строке) берём отступ самого объявления.
      const closingLineStart = before.lastIndexOf('\n', decl.bodyEnd - 1) + 1;
      const beforeBrace = before.slice(closingLineStart, decl.bodyEnd);
      const declLineStart = before.lastIndexOf('\n', decl.start - 1) + 1;
      const closingIndent = /^\s*$/u.test(beforeBrace) ? beforeBrace : before.slice(declLineStart, decl.start).match(/^[ \t]*/u)?.[0] ?? '';
      return `${before.slice(0, decl.bodyStart)}\n${indented}\n${closingIndent}${before.slice(decl.bodyEnd)}`;
    }
    case 'insert_after':
    case 'insert_before': {
      const at = op.op === 'insert_after' ? decl.end : decl.start;
      const insertion = op.body.replace(/\r\n/gu, '\n').replace(/^\n+|\s+$/gu, '');
      const left = before.slice(0, at).replace(/\s+$/u, '');
      const right = before.slice(at).replace(/^\s*\n/u, '');
      if (left === '') return `${insertion}\n${right}`;
      return `${left}\n\n${insertion}\n${right}`.replace(/\n{3,}/gu, '\n\n');
    }
    case 'delete': {
      const left = before.slice(0, decl.start).replace(/\s+$/u, '');
      const right = before.slice(decl.end).replace(/^\s*\n/u, '');
      if (left === '') return right;
      if (right === '') return `${left}\n`;
      return `${left}\n${right}`.replace(/\n{3,}/gu, '\n\n');
    }
    case 'rename': {
      if (decl.name !== op.newName && decls.some(d => d.name === op.newName || d.qualified === op.newName)) {
        fail('rename_conflict', op, `rename: имя ${op.newName} уже занято в ${op.file}`,
          { candidates: decls.filter(d => d.name === op.newName).map(d => d.qualified) });
      }
      return renameIdentifier(before, decl.name, op.newName);
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Неизвестная операция: ${JSON.stringify(exhaustive)}`);
    }
  }
}
