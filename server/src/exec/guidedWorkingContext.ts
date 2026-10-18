import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { readTree } from '../explore/tree.ts';
import { tsSpecifierCandidatesPosix } from '../fs/tsSpecifier.ts';
import { guardedPath } from './GuidedExecutor.ts';
import { findSymbols, identifierOccurrences } from './symbolOps.ts';
import { progressHash } from '../run/guidedProgress.ts';

export interface WorkingTask { file: string; symbol?: string | null; action: string; claims: readonly string[] }
export interface WorkingFragment { path: string; role: 'target' | 'dependency' | 'consumer' | 'test-example'; symbol: string | null;
  startLine: number; endLine: number; text: string; partial: boolean; hash: string }
export interface GuidedWorkingContext { fragments: WorkingFragment[]; imports: { file: string; statement: string; resolved: string | null }[];
  missing: { path: string; reason: string }[]; hashes: Record<string, string>; partial: boolean }

/** A bounded, fresh packet of already observed dependencies and approved targets.
 * It gives no new write rights. Every incomplete fragment carries its line address. */
export function buildGuidedWorkingContext(root: string, targets: readonly string[], tasks: readonly WorkingTask[], observed: ReadonlySet<string>,
  vocabulary = '', maxChars = 14000, includeConsumers = false): GuidedWorkingContext {
  const tree = readTree(root);
  const indexed = new Map(tree.files.map(file => [file.path, file]));
  const allowed = new Set([...observed, ...targets]);
  const result: GuidedWorkingContext = { fragments: [], imports: [], missing: [], hashes: {}, partial: false };
  let remaining = maxChars;
  const add = (path: string, role: WorkingFragment['role'], name: string | null, start: number, end: number): void => {
    const file = indexed.get(path);
    if (!file || !allowed.has(path) || remaining <= 0 || result.fragments.some(fragment => fragment.path === path && fragment.symbol === name)) return;
    const selected = file.text.slice(start, end);
    const text = selected.slice(0, Math.min(remaining, role === 'test-example' ? 2500 : 4500));
    const startLine = file.text.slice(0, start).split('\n').length;
    const hash = progressHash(readFileSync(guardedPath(root, path), 'utf8'));
    result.hashes[path] = hash;
    result.fragments.push({ path, role, symbol: name, startLine, endLine: startLine + text.split('\n').length - 1,
      text, hash, partial: text.length < selected.length });
    remaining -= text.length;
    if (text.length < selected.length) result.partial = true;
  };
  const dependencyPaths = new Set<string>();
  const consumerPaths = new Set<string>();
  if (includeConsumers) {
    for (const file of tree.files) {
      if (targets.includes(file.path) || !/\.[cm]?[jt]sx?$/u.test(file.path)) continue;
      const positions = new Set(['from', 'require', 'import'].flatMap(name => identifierOccurrences(file.text, name)));
      // Literal static imports/reexports/CommonJS only; dynamic resolution remains unknown.
      for (const match of file.text.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"\n]+)['"]/gu)) {
        if (!positions.has(match.index)) continue;
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        const matches = [...new Set(tsSpecifierCandidatesPosix(posix.normalize(posix.join(posix.dirname(file.path), specifier))).filter(candidate => indexed.has(candidate)))];
        if (matches.length > 1) {
          if (matches.some(path => targets.includes(path))) result.missing.push({ path: file.path, reason: 'Неоднозначный путь импорта потребителя; требуется исследование' });
          continue;
        }
        const resolved = matches[0];
        if (!resolved || !targets.includes(resolved)) continue;
        if (observed.has(file.path)) consumerPaths.add(file.path);
        else result.missing.push({ path: file.path, reason: 'Прямой потребитель ещё не исследован; требуется read' });
      }
    }
  }
  const words = new Set((vocabulary + '\n' + tasks.map(task => `${task.symbol ?? ''} ${task.action}`).join('\n')).match(/[A-Za-z_$][\w$]*/gu) ?? []);
  for (const path of targets) {
    const file = indexed.get(path);
    if (!file) { result.missing.push({ path, reason: 'Файл новый либо отсутствует в ограниченном индексе; наличие проверяется отдельно карточкой файла' }); continue; }
    const declarations = findSymbols(file.text);
    const selected = tasks.filter(task => task.file === path).flatMap(task => declarations.filter(decl => decl.qualified === task.symbol || decl.name === task.symbol));
    if (selected.length) for (const decl of selected) add(path, 'target', decl.qualified, decl.start, decl.end);
    else add(path, 'target', null, 0, file.text.length);
    for (const match of file.text.matchAll(/^[ \t]*import\s+(?:(?:type\s+)?[^;]*?\s+from\s+)?['"]([^'"\n]+)['"][^\n;]*;?/gmu)) {
      const specifier = match[1]!;
      const resolved = specifier.startsWith('.') ? tsSpecifierCandidatesPosix(posix.normalize(posix.join(posix.dirname(path), specifier))).find(candidate => indexed.has(candidate)) ?? null : null;
      result.imports.push({ file: path, statement: match[0], resolved });
      (match[0].match(/[A-Za-z_$][\w$]*/gu) ?? []).forEach(word => words.add(word));
      if (resolved && allowed.has(resolved)) dependencyPaths.add(resolved);
      else if (resolved) result.missing.push({ path: resolved, reason: 'Зависимость ещё не исследована; требуется read' });
    }
  }
  for (const file of tree.files) {
    if (!observed.has(file.path) || targets.includes(file.path) || file.kind !== 'code') continue;
    const declarations = findSymbols(file.text);
    const relevant = declarations.filter(decl => words.has(decl.name) || words.has(decl.qualified));
    if (dependencyPaths.has(file.path) || relevant.length) {
      for (const decl of relevant.length ? relevant : declarations.filter(decl => decl.exported).slice(0, 4)) add(file.path, 'dependency', decl.qualified, decl.start, decl.end);
    }
  }
  for (const path of consumerPaths) {
    const file = indexed.get(path)!;
    add(path, 'consumer', null, 0, file.text.length);
    if (!result.fragments.some(fragment => fragment.path === path)) result.missing.push({ path, reason: 'Потребитель не поместился в бюджет контекста; требуется адресное чтение' });
  }
  // Existing exported types are a small fallback for a new module with no import yet.
  if (!result.fragments.some(fragment => fragment.role === 'dependency')) {
    for (const file of tree.files.filter(file => observed.has(file.path) && file.kind === 'code' && !targets.includes(file.path))) {
      for (const decl of findSymbols(file.text).filter(decl => decl.exported && ['interface', 'type'].includes(decl.kind)).slice(0, 2)) add(file.path, 'dependency', decl.qualified, decl.start, decl.end);
      if (result.fragments.filter(fragment => fragment.role === 'dependency').length >= 4) break;
    }
  }
  const tests = tree.files.filter(file => file.kind === 'test' && observed.has(file.path) && !targets.includes(file.path));
  const example = tests.find(file => [...words].some(word => word.length > 3 && file.text.includes(word))) ?? tests[0];
  if (example) add(example.path, 'test-example', null, 0, example.text.length);
  if (tree.skipped.files || tree.skipped.bytes || result.missing.length || remaining <= 0) result.partial = true;
  return result;
}

export function workingContextCurrent(root: string, context: Pick<GuidedWorkingContext, 'hashes'>): boolean {
  return Object.entries(context.hashes).every(([path, hash]) => {
    try { return progressHash(readFileSync(guardedPath(root, path), 'utf8')) === hash; } catch { return false; }
  });
}
