/**
 * Операции этапа chunk над символами: позицию объявления и совпадение с исходником
 * материализует рантайм. В guided v5 строки с кодом создаёт детерминированный
 * typedPatchCompiler из IR; здесь остаются только охраняемые базовые операции.
 * Байт-точных SEARCH-фрагментов для кода в протоколе нет.
 *
 * Границы объявлений вычисляет TypeScript AST в syntaxIndex.ts. Неоднозначность имени —
 * отказ с кандидатами (qualified-имена вида `Class.method`), а не угадывание.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { syntaxIndex, isSingleDeclaration } from './syntaxIndex.ts';

export const isTextDocument = (path: string): boolean => /\.(?:md|mdx|txt|rst|adoc)$/iu.test(path);

export const symbolNameSchema = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u, 'Точное имя символа из карточки');

const file = z.string().min(1);
export const SymbolOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace_declaration'), file, symbol: symbolNameSchema, expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), targetId: z.string().regex(/^[a-f0-9]{64}$/u), declaration: z.string().min(1) }).strict(),
  z.object({ op: z.literal('replace_function_body'), file, symbol: symbolNameSchema, expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), targetId: z.string().regex(/^[a-f0-9]{64}$/u), body: z.string().min(1) }).strict(),
  z.object({ op: z.literal('replace_text'), file, expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), search: z.string().min(1), replacement: z.string() }).strict(),
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
  /** Zero-based index in the proposed transaction, with the simulated pre-operation state. */
  opIndex?: number;
  beforeHash?: string;
  beforeSymbols?: string[];
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

export type ResolveResult = { ok: true; decl: SymbolDecl } | { ok: false; ambiguous: boolean; candidates: string[] };

export const findSymbols = syntaxIndex;
export const declarationId = (source: string, decl: SymbolDecl): string => createHash('sha256').update(JSON.stringify([source, decl.kind, decl.qualified, decl.start, decl.end])).digest('hex');

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
export function applySymbolOp(before: string | null, op: SymbolOp, original: string | null = before): string {
  if (op.op === 'create_file') {
    if (before !== null) fail('not_new_file', op, `create_file: ${op.file} уже существует; используй операции над символами`);
    return op.body.replace(/\r\n/gu, '\n').trimEnd() + '\n';
  }
  if (before === null) fail('missing_declaration', op, `${op.op}: файл ${op.file} не существует; новый файл создаётся только через create_file`);
  if (op.op === 'replace_text') {
    if (!isTextDocument(op.file)) fail('missing_declaration', op, 'replace_text поддерживает только текстовые документы md/mdx/txt/rst/adoc');
    if (createHash('sha256').update(before).digest('hex') !== op.expectedHash) fail('missing_declaration', op, 'replace_text: источник изменился; перечитай текущий файл');
    const at = before.indexOf(op.search);
    if (at < 0 || before.indexOf(op.search, at + 1) >= 0) fail('missing_declaration', op, 'replace_text: search должен встречаться ровно один раз; используй более полный фрагмент');
    return before.slice(0, at) + op.replacement + before.slice(at + op.search.length);
  }
  if (isTextDocument(op.file)) fail('missing_declaration', op, 'Для текстового документа используй replace_text с текущим хешем и уникальным фрагментом');
  if (op.op === 'replace_declaration' || op.op === 'replace_function_body') {
    if (original === null || createHash('sha256').update(original).digest('hex') !== op.expectedHash) fail('missing_declaration', op, 'Исходник целевой операции изменился; требуется новый пакет');
    const target = findSymbols(original).find(decl => declarationId(original, decl) === op.targetId && decl.qualified === op.symbol);
    if (!target) fail('missing_declaration', op, 'Идентификатор объявления не принадлежит закреплённому символу');
    const candidates = findSymbols(before).filter(decl => decl.qualified === target.qualified && decl.kind === target.kind &&
      before.slice(decl.start, decl.end) === original.slice(target.start, target.end));
    if (candidates.length !== 1) fail('ambiguous_symbol', op, 'Объявление изменилось или неоднозначно в текущей транзакции');
    const current = candidates[0]!;
    if (op.op === 'replace_declaration') {
      const member = target.qualified.includes('.');
      const declarations = member ? findSymbols(`class ${target.qualified.split('.')[0]} {\n${op.declaration}\n}`).filter(decl => decl.qualified.includes('.')) : findSymbols(op.declaration).filter(decl => !decl.qualified.includes('.'));
      if (!isSingleDeclaration(op.declaration,member?target.qualified.split('.')[0]:undefined) || declarations.length !== 1 || declarations[0]!.qualified !== target.qualified || declarations[0]!.kind !== target.kind ||
          !member && op.declaration.slice(declarations[0]!.end).trim()) fail('missing_declaration', op, 'Нужно одно полное объявление закреплённого имени и вида; вспомогательные объявления добавляй отдельной разрешённой операцией');
      return before.slice(0, current.start) + op.declaration.trimEnd() + before.slice(current.end);
    }
    if (!['function', 'method', 'variable'].includes(target.kind) || current.bodyStart === null || current.bodyEnd === null) fail('missing_declaration', op, 'Цель не имеет исполняемого тела функции');
    return before.slice(0, current.bodyStart) + '\n' + op.body.trim() + '\n' + before.slice(current.bodyEnd);
  }
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
      if (/^\s*export\b/u.test(op.body) && !declaresSymbol(op.body, decl.name)) {
        const proposed = findSymbols(op.body).filter(symbol => !symbol.qualified.includes('.'));
        fail('missing_declaration', op,
          `replace_body: закреплён ${decl.kind} ${decl.qualified}, но получено другое полное объявление (${proposed.map(symbol => `${symbol.kind} ${symbol.qualified}`).join(', ') || 'не распознано'}). Верни тело или полное объявление именно ${decl.qualified}; другой символ требует отдельного шага плана.`,
          { candidates: [decl.qualified], snippet: before.slice(decl.start, decl.end).slice(0, 3000) });
      }
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
