import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { readTree } from '../explore/tree.ts';
import { tsSpecifierCandidatesPosix } from '../fs/tsSpecifier.ts';
import { guardedPath } from './GuidedExecutor.ts';
import { findSymbols, identifierOccurrences } from './symbolOps.ts';
import { progressHash } from '../run/guidedProgress.ts';

export interface WorkingTask { file: string; symbol?: string | null; action: string; claims: readonly string[]; contractChange?: string | null }
export interface WorkingFragment { path: string; role: 'target' | 'dependency' | 'consumer' | 'test-example'; symbol: string | null;
  startLine: number; endLine: number; text: string; partial: boolean; hash: string; evidenceId: string }
export type EvidenceRequirementStatus = 'ready' | 'missing' | 'partial' | 'uncertain' | 'not-applicable';
export interface EvidenceRequirement { id: string; kind: 'claim' | 'target' | 'dependency' | 'consumer' | 'intermediate-state' | 'latest-check';
  status: EvidenceRequirementStatus; path: string | null; claimIds: readonly string[]; evidenceIds: readonly string[]; reason: string }
export interface DecisionEvidence { id: string; kind: EvidenceRequirement['kind']; hash: string; path: string | null }
export interface GuidedWorkingContext { fragments: WorkingFragment[]; imports: { file: string; statement: string; resolved: string | null }[];
  missing: { path: string; reason: string }[]; hashes: Record<string, string>; partial: boolean;
  requirements: EvidenceRequirement[]; decisionEvidence: DecisionEvidence[] }

const evidenceId = (kind: string, value: unknown): string => `evidence-${kind}-${progressHash(value).slice(0, 20)}`;

export class GuidedEvidenceError extends Error {
  readonly retryStage = 'explore' as const;
}

export function guidedEvidenceProblems(context: GuidedWorkingContext): string[] {
  return context.requirements.filter(requirement => requirement.status === 'missing' || requirement.status === 'partial' ||
    requirement.status === 'uncertain' && requirement.evidenceIds.length === 0)
    .map(requirement => `${requirement.kind} ${requirement.path ?? requirement.id}: ${requirement.status} — ${requirement.reason}`);
}

/** Пути dependency/consumer, которые ещё можно дочитать с диска до генерации патча. */
export function missingEvidencePaths(context: GuidedWorkingContext): string[] {
  const paths = new Set<string>();
  for (const requirement of context.requirements) {
    if (requirement.path === null) continue;
    if (requirement.kind !== 'dependency' && requirement.kind !== 'consumer') continue;
    if (requirement.status !== 'missing' && requirement.status !== 'partial') continue;
    if (requirement.status === 'partial' && requirement.evidenceIds.length > 0) continue;
    paths.add(requirement.path);
  }
  for (const missing of context.missing) paths.add(missing.path);
  return [...paths];
}

export function supplementGuidedDecisionEvidence(context: GuidedWorkingContext, input: {
  claims: readonly { id: string; text: string }[]; intermediateState?: unknown; latestCheck?: string | null;
}): GuidedWorkingContext {
  const result = structuredClone(context);
  const claimIds = input.claims.map(claim => claim.id);
  if (claimIds.length) {
    const id = evidenceId('claim', input.claims);
    result.decisionEvidence.push({ id, kind: 'claim', hash: progressHash(input.claims), path: null });
    result.requirements.push({ id: `requirement-${id}`, kind: 'claim', status: 'ready', path: null, claimIds,
      evidenceIds: [id], reason: 'Исходные формулировки требований привязаны к хешу' });
  }
  if (input.intermediateState !== undefined) {
    const id = evidenceId('intermediate', input.intermediateState);
    result.decisionEvidence.push({ id, kind: 'intermediate-state', hash: progressHash(input.intermediateState), path: null });
    result.requirements.push({ id: `requirement-${id}`, kind: 'intermediate-state', status: 'ready', path: null, claimIds,
      evidenceIds: [id], reason: 'Предыдущие операции текущей группы применены к виртуальному промежуточному состоянию' });
  }
  if (input.latestCheck) {
    const id = evidenceId('check', input.latestCheck);
    result.decisionEvidence.push({ id, kind: 'latest-check', hash: progressHash(input.latestCheck), path: null });
    result.requirements.push({ id: `requirement-${id}`, kind: 'latest-check', status: 'ready', path: null, claimIds,
      evidenceIds: [id], reason: 'Последняя фактическая проверка учтена в ремонте' });
  }
  return result;
}

/**
 * Claim / intermediate-state / latest-check — хеши уже в пакете. Модель часто цитирует
 * target/dependency и забывает обязательные id; без дописывания один и тот же patch
 * дважды отвергается с тем же proposalHash (r4 mellum; series 2026-10-29). Target не трогаем.
 */
export function attachMissingClaimEvidence<T extends { action: string; evidenceIds?: readonly string[] | undefined }>(
  reply: T, context: GuidedWorkingContext,
): T {
  if (reply.action !== 'patch' && reply.action !== 'no_change') return reply;
  const known = new Set(context.decisionEvidence.map(evidence => evidence.id));
  const selected = [...(reply.evidenceIds ?? [])];
  if (selected.length === 0 || selected.some(id => !known.has(id))) return reply;
  let changed = false;
  for (const requirement of context.requirements) {
    if (!['claim', 'intermediate-state', 'latest-check'].includes(requirement.kind) || requirement.status === 'not-applicable') continue;
    if (requirement.evidenceIds.some(id => selected.includes(id))) continue;
    const id = requirement.evidenceIds.find(candidate => known.has(candidate));
    if (id === undefined) continue;
    selected.push(id);
    changed = true;
  }
  return changed ? { ...reply, evidenceIds: selected } : reply;
}

export function validateGuidedDecisionEvidence(reply: { action: string; evidenceIds?: readonly string[] | undefined }, context: GuidedWorkingContext): void {
  if (reply.action !== 'patch' && reply.action !== 'no_change') return;
  const known = new Set(context.decisionEvidence.map(evidence => evidence.id));
  const selected = new Set(reply.evidenceIds ?? []);
  if (selected.size === 0 || [...selected].some(id => !known.has(id))) throw new Error('Решение должно ссылаться только на evidenceId из актуального evidence пакета');
  const required = context.requirements.filter(requirement => ['claim', 'target', 'intermediate-state', 'latest-check'].includes(requirement.kind) && requirement.status !== 'not-applicable');
  for (const requirement of required) if (!requirement.evidenceIds.some(id => selected.has(id))) {
    throw new Error(`Решение не ссылается на обязательное доказательство ${requirement.kind}: ${requirement.path ?? requirement.claimIds.join(', ')}`);
  }
}

/** A bounded, fresh packet of already observed dependencies and approved targets.
 * It gives no new write rights. Every incomplete fragment carries its line address. */
export function buildGuidedWorkingContext(root: string, targets: readonly string[], tasks: readonly WorkingTask[], observed: ReadonlySet<string>,
  vocabulary = '', maxChars = 14000, includeConsumers = false): GuidedWorkingContext {
  const tree = readTree(root);
  const indexed = new Map(tree.files.map(file => [file.path, file]));
  const allowed = new Set([...observed, ...targets]);
  const result: GuidedWorkingContext = { fragments: [], imports: [], missing: [], hashes: {}, partial: false, requirements: [], decisionEvidence: [] };
  let remaining = maxChars;
  const add = (path: string, role: WorkingFragment['role'], name: string | null, start: number, end: number): void => {
    const file = indexed.get(path);
    if (!file || !allowed.has(path) || result.fragments.some(fragment => fragment.path === path && fragment.symbol === name)) return;
    if (remaining <= 0) {
      const kind = role === 'test-example' ? 'dependency' : role;
      result.requirements.push({ id: evidenceId('context-exhausted', { path, role, symbol: name, start }), kind, status: 'partial', path,
        claimIds: [...new Set(tasks.flatMap(task => task.claims))], evidenceIds: [], reason: 'Обязательный фрагмент не поместился в бюджет контекста; требуется адресное чтение' });
      return;
    }
    const selected = file.text.slice(start, end);
    const text = selected.slice(0, Math.min(remaining, role === 'test-example' ? 2500 : 4500));
    const startLine = file.text.slice(0, start).split('\n').length;
    const hash = progressHash(readFileSync(guardedPath(root, path), 'utf8'));
    result.hashes[path] = hash;
    const id = evidenceId(role, { path, symbol: name, startLine, text, hash });
    result.decisionEvidence.push({ id, kind: role === 'test-example' ? 'dependency' : role, hash, path });
    result.fragments.push({ path, role, symbol: name, startLine, endLine: startLine + text.split('\n').length - 1,
      text, hash, partial: text.length < selected.length, evidenceId: id });
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
        if (!specifier.startsWith('.')) {
          if (/^(?:@\/|~\/|#)/u.test(specifier)) {
            if (observed.has(file.path)) consumerPaths.add(file.path);
            else result.missing.push({ path: file.path, reason: 'Потенциальный потребитель через alias ещё не исследован; требуется read' });
          }
          continue;
        }
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
      for (const match of file.text.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu)) {
        if (!positions.has(match.index)) continue;
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) {
          if (/^(?:@\/|~\/|#)/u.test(specifier)) {
            if (observed.has(file.path)) consumerPaths.add(file.path);
            else result.missing.push({ path: file.path, reason: 'Динамический потребитель через alias ещё не исследован; требуется read' });
          }
          continue;
        }
        const matches = tsSpecifierCandidatesPosix(posix.normalize(posix.join(posix.dirname(file.path), specifier))).filter(candidate => targets.includes(candidate));
        if (!matches.length) continue;
        if (observed.has(file.path)) consumerPaths.add(file.path);
        else result.missing.push({ path: file.path, reason: 'Динамический потребитель ещё не исследован; требуется read' });
      }
    }
  }
  const words = new Set((vocabulary + '\n' + tasks.map(task => `${task.symbol ?? ''} ${task.action}`).join('\n')).match(/[A-Za-z_$][\w$]*/gu) ?? []);
  for (const path of targets) {
    const file = indexed.get(path);
    if (!file) {
      if (existsSync(guardedPath(root, path))) result.missing.push({ path, reason: 'Существующая цель отсутствует в ограниченном индексе; требуется адресное чтение' });
      continue;
    }
    const declarations = findSymbols(file.text);
    const selected = tasks.filter(task => task.file === path).flatMap(task => declarations.filter(decl => decl.qualified === task.symbol || decl.name === task.symbol));
    if (selected.length) for (const decl of selected) add(path, 'target', decl.qualified, decl.start, decl.end);
    else add(path, 'target', null, 0, file.text.length);
    const claimIds = [...new Set(tasks.filter(task => task.file === path).flatMap(task => task.claims))];
    const importPositions = new Set(identifierOccurrences(file.text, 'import'));
    const hasDynamicImport = [...file.text.matchAll(/\bimport\s*\(/gu)].some(match => importPositions.has(match.index));
    if (hasDynamicImport) result.requirements.push({ id: evidenceId('dynamic-import', path), kind: 'dependency', status: 'uncertain', path,
      claimIds, evidenceIds: result.fragments.filter(fragment => fragment.role === 'target' && fragment.path === path).map(fragment => fragment.evidenceId),
      reason: 'Динамический импорт показан в актуальном исходнике, но не доказывает полную карту зависимостей' });
    for (const match of file.text.matchAll(/^[ \t]*import\s+(?:(?:type\s+)?[^;]*?\s+from\s+)?['"]([^'"\n]+)['"][^\n;]*;?/gmu)) {
      const specifier = match[1]!;
      const candidates = specifier.startsWith('.') ? tsSpecifierCandidatesPosix(posix.normalize(posix.join(posix.dirname(path), specifier))).filter(candidate => indexed.has(candidate)) : [];
      const resolved = candidates.length === 1 ? candidates[0]! : null;
      result.imports.push({ file: path, statement: match[0], resolved });
      (match[0].match(/[A-Za-z_$][\w$]*/gu) ?? []).forEach(word => words.add(word));
      if (resolved && allowed.has(resolved)) dependencyPaths.add(resolved);
      else if (resolved) result.missing.push({ path: resolved, reason: 'Зависимость ещё не исследована; требуется read' });
      else if (specifier.startsWith('.') || /^(?:@\/|~\/|#)/u.test(specifier)) result.requirements.push({ id: evidenceId('unresolved-import', match[0]), kind: 'dependency', status: 'uncertain', path,
        claimIds, evidenceIds: [], reason: `Не разрешён импорт ${specifier}; alias и неоднозначный путь остаются uncertain` });
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
  for (const path of targets) {
    const fragments = result.fragments.filter(fragment => fragment.role === 'target' && fragment.path === path);
    const claimIds = [...new Set(tasks.filter(task => task.file === path).flatMap(task => task.claims))];
    const exists = existsSync(guardedPath(root, path));
    const status: EvidenceRequirementStatus = !indexed.has(path) && !exists ? 'not-applicable' : fragments.length === 0 ? 'missing' : fragments.some(fragment => fragment.partial) ? 'partial' : 'ready';
    result.requirements.push({ id: evidenceId('target-requirement', { path, claimIds }), kind: 'target', status, path, claimIds,
      evidenceIds: fragments.map(fragment => fragment.evidenceId), reason: status === 'not-applicable' ? 'Новый файл: исходная декларация отсутствует по определению'
        : status === 'ready' ? 'Актуальная цель и её декларация или file/hunk evidence предоставлены' : 'Для существующей цели нужен полный актуальный target declaration или file/hunk evidence' });
  }
  for (const missing of result.missing) {
    const kind = /потребител/iu.test(missing.reason) ? 'consumer' : 'dependency';
    result.requirements.push({ id: evidenceId('missing', missing), kind, status: 'missing', path: missing.path,
      claimIds: [...new Set(tasks.flatMap(task => task.claims))], evidenceIds: [], reason: missing.reason });
  }
  for (const fragment of result.fragments.filter(fragment => fragment.role === 'dependency' || fragment.role === 'consumer')) {
    result.requirements.push({ id: `requirement-${fragment.evidenceId}`, kind: fragment.role === 'consumer' ? 'consumer' : 'dependency', status: fragment.partial ? 'partial' : 'ready', path: fragment.path,
      claimIds: [...new Set(tasks.flatMap(task => task.claims))], evidenceIds: [fragment.evidenceId],
      reason: fragment.partial ? 'Фрагмент обрезан бюджетом контекста; требуется адресное чтение' : 'Фрагмент привязан к актуальному хешу источника' });
  }
  if (includeConsumers) for (const file of tree.files) {
    if (targets.includes(file.path)) continue;
    const positions = new Set(['from', 'require', 'import'].flatMap(name => identifierOccurrences(file.text, name)));
    for (const match of file.text.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu)) {
      if (!positions.has(match.index)) continue;
      const specifier = match[1]!;
      if (!specifier.startsWith('.')) continue;
      const matches = tsSpecifierCandidatesPosix(posix.normalize(posix.join(posix.dirname(file.path), specifier))).filter(candidate => targets.includes(candidate));
      if (matches.length) result.requirements.push({ id: evidenceId('dynamic-consumer', { path: file.path, specifier }), kind: 'consumer', status: 'uncertain', path: file.path,
        claimIds: [...new Set(tasks.flatMap(task => task.claims))],
        evidenceIds: result.fragments.filter(fragment => fragment.role === 'consumer' && fragment.path === file.path && !fragment.partial).map(fragment => fragment.evidenceId),
        reason: observed.has(file.path) ? 'Динамический consumer прочитан, но полная карта вызовов остаётся неопределённой' : 'Динамический consumer ещё не исследован; требуется read' });
    }
    for (const match of file.text.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?['"]((?:@\/|~\/|#)[^'"\n]+)['"]/gu)) {
      if (!positions.has(match.index)) continue;
      const specifier = match[1]!;
      result.requirements.push({ id: evidenceId('alias-consumer', { path: file.path, specifier }), kind: 'consumer', status: 'uncertain', path: file.path,
        claimIds: [...new Set(tasks.flatMap(task => task.claims))],
        evidenceIds: result.fragments.filter(fragment => fragment.role === 'consumer' && fragment.path === file.path && !fragment.partial).map(fragment => fragment.evidenceId),
        reason: observed.has(file.path) ? `Consumer с alias ${specifier} прочитан; разрешение alias и полнота вызовов остаются uncertain` : `Consumer с alias ${specifier} ещё не исследован` });
    }
  }
  if (tree.skipped.files || tree.skipped.bytes || result.missing.length || remaining <= 0) result.partial = true;
  return result;
}

export function workingContextCurrent(root: string, context: Pick<GuidedWorkingContext, 'hashes'>): boolean {
  return Object.entries(context.hashes).every(([path, hash]) => {
    try { return progressHash(readFileSync(guardedPath(root, path), 'utf8')) === hash; } catch { return false; }
  });
}
