import type { Question } from '@sdlc-runner/shared';
import { foldPathCase } from '../policy/paths.ts';

/** Same membership rule as TaskLoopExecutor.inTaskPaths — kept local to avoid an import cycle. */
function inWritable(path: string, writable: readonly string[]): boolean {
  const normalized = foldPathCase(path.replaceAll('\\', '/'));
  return writable.some(entry => {
    const p = foldPathCase(entry.replaceAll('\\', '/'));
    return p.endsWith('/') ? normalized === p.slice(0, -1) || normalized.startsWith(p) : normalized === p;
  });
}

/**
 * Runtime answers for AskHuman that must not block the loop on a human/bank miss:
 * scope expansion, harness introspection, technique speculation, contract restatement, or meta-review.
 * Returns null when the question should still go to the human adapter.
 */
export function askHumanRuntimeReply(
  questions: readonly Question[],
  writable: readonly string[],
  taskText = '',
): string | null {
  const blob = questions.map(questionText).join('\n');
  if (blob.trim() === '') return null;

  const outside = proposedPaths(blob).filter(path => !inWritable(path, writable));
  if (outside.length > 0) {
    return [
      'Rejected: stay inside the human write boundaries',
      JSON.stringify(writable),
      `Proposed path(s) outside the contract: ${outside.join(', ')}.`,
      'Check names label verification categories, not directories to create.',
      'Implement under the writable prefixes; do not AskHuman for a scope expansion.',
    ].join(' ');
  }

  if (HARNESS_INTROSPECTION.test(blob)) {
    return [
      'Rejected: registered check internals are not a human business fact.',
      'Use the written task and failing assertion text; repair the implementation under writable prefixes.',
      'Do not AskHuman about harness files outside the project.',
    ].join(' ');
  }

  if (IMPLEMENTATION_SPECULATION.test(blob)) {
    return [
      'Rejected: implementation technique and error-type preference are not missing business facts.',
      'Follow the written contract; when an own property is required, use Object.defineProperty.',
      'Summarize and continue; do not AskHuman for coding style.',
    ].join(' ');
  }

  if (CREATE_OUTSIDE_CATALOG.test(blob) && !mentionsOnlyWritable(blob, writable)) {
    return [
      'Rejected: do not create directories outside the human write boundaries',
      JSON.stringify(writable) + '.',
      'Check names are not filesystem paths. Implement under the writable prefixes only.',
    ].join(' ');
  }

  if (META_REVIEW.test(blob)) {
    return [
      'Rejected: meta-review is not a missing business fact.',
      'Put acceptance judgment, scope notes and remaining limitations in your final summary.',
      'Do not AskHuman to confirm that the implementation satisfies the written requirements.',
    ].join(' ');
  }

  if (CONTRACT_RESTATEMENT.test(blob) || (taskText.trim() !== '' && ASKS_BEHAVIOR_FOR_INPUT.test(blob))) {
    return [
      'Rejected: follow the written task text; do not AskHuman to reconfirm behavior already specified in the contract.',
      taskText.trim() === '' ? '' : 'Re-read the task and implement the stated behavior; use registered checks for evidence.',
    ].filter(Boolean).join(' ');
  }

  return null;
}

function questionText(q: Question): string {
  const options = (q.options ?? []).map(o => `${o.label}\n${o.description ?? ''}`).join('\n');
  return `${q.header ?? ''}\n${q.question}\n${options}`;
}

/** Relative path-like tokens from free text (quoted, backticked, or bare with a slash). */
export function proposedPaths(text: string): string[] {
  const found = new Set<string>();
  const consider = (raw: string): void => {
    let path = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    if (path.startsWith('/') || path.includes('://') || /^(?:[A-Za-z]:)/u.test(path)) return;
    if (path.split('/').includes('..')) return;
    path = path.replace(/^[`'"]|[`'"]$/gu, '');
    if (!path || path === '.' || !path.includes('/')) return;
    path = path.replace(/[),.;:!?]+$/u, '');
    if (!/^[\w./@+-]+$/u.test(path)) return;
    found.add(path);
    const slash = path.lastIndexOf('/');
    if (slash > 0) found.add(path.slice(0, slash + 1));
  };
  for (const match of text.matchAll(/[`'"]((?:\.\/)?[\w./@+-]+\/(?:[\w./@+-]*))[`'"]/gu)) consider(match[1]!);
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])((?:\.\/)?[\w.-]+\/(?:[\w./@+-]*))/gu)) consider(match[1]!);
  return [...found];
}

/**
 * New test files must match the seed suite shape (same extension; keep .test./.spec. when seeds use it).
 * Measured: Ministral wrote test/csvRow.test.js while the fixture only runs *.mjs.
 */
export function matchesExecutableTestShape(path: string, seedTestFiles: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/');
  const ext = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.')) : '';
  if (seedTestFiles.length === 0) {
    return /\.(test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
  }
  const seedExts = new Set(seedTestFiles.map(file => {
    const n = file.replaceAll('\\', '/');
    return n.includes('.') ? n.slice(n.lastIndexOf('.')) : '';
  }).filter(Boolean));
  if (ext === '' || !seedExts.has(ext)) return false;
  const seedUsesInfix = seedTestFiles.some(file => /\.(test|spec)\./u.test(file.replaceAll('\\', '/')));
  if (seedUsesInfix) return /\.(test|spec)\./u.test(normalized);
  return true;
}

const HARNESS_INTROSPECTION =
  /bench\/checks|\.visible\.mjs|\.hidden\.mjs|harness[- ]side|registered check.*\b(broken|stale)\b|Cannot read properties of undefined \(reading ['"]value['"]\)/iu;

const IMPLEMENTATION_SPECULATION =
  /(?:\b(?:TypeError|RangeError)\b.{0,80}\b(?:or|prefer|лучше|предпочт))|(?:Object\.defineProperty)|(?:ordinary assignment)|(?:обычн(?:ое|ым)\s+присваиван)/iu;

const CREATE_OUTSIDE_CATALOG =
  /(?:create|созда(?:ть|ю|дим|вать)|завести).{0,60}(?:examples?|docs|каталог|директори|folder|directory)|(?:examples?|docs)\s*\//iu;

/** Self-grading / wrap-up questions that belong in the final summary, not AskHuman. */
const META_REVIEW =
  /(?:does|do)\s+the\s+.+\s+satisfy|(?:satisfy|satisfies)\s+(?:all\s+)?(?:the\s+)?requirements|need to expand (?:the )?scope|remaining limitations|was there any need to expand|any need to expand the scope/iu;

/** Asking the human to pick expected outputs already owned by the written task. */
const CONTRACT_RESTATEMENT =
  /(?:expected behavior|what should (?:be )?(?:the )?expected)|what should \w+ (?:return|do|throw)|should (?:\w+ )?(?:return|throw).{0,40}for/iu;

const ASKS_BEHAVIOR_FOR_INPUT =
  /(?:for (?:input|the input)|when (?:given|called with)|для входа|для input)\s*[\[`'"({\d]/iu;

function mentionsOnlyWritable(text: string, writable: readonly string[]): boolean {
  const paths = proposedPaths(text);
  return paths.length > 0 && paths.every(path => inWritable(path, writable));
}
