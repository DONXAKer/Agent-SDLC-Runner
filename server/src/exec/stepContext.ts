import { readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, posix } from 'node:path';

import type { PlanStep } from '../artifacts/planSteps.ts';
import { symlinkEscape } from '../approval/symlink.ts';
import { listSourceFiles } from '../gates/builtin/index.ts';
import { relativizeWithin, resolveUserPath } from '../policy/paths.ts';
import { cap } from './tools/index.ts';

const SOURCE_LIMIT = 1_000;
const FILE_EXCERPT_BYTES = 2_000;
const API_MAP_BYTES = 1_800;
export const STEP_CONTEXT_BYTES = 6_000;
const TEST_RE = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;
const IMPORT_RE = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DECL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\b/;
const IMPORT_LINE_RE = /^\s*(?:import|export)\b.*\bfrom\s+['"]|^\s*import\s+['"]|require\(/;

function read(root: string, file: string): string | null {
  try {
    const resolved = resolveUserPath(root, file);
    if (relativizeWithin(root, resolved) === null || symlinkEscape(root, file, []) !== null) return null;
    return readFileSync(realpathSync(resolved), 'utf8');
  } catch {
    return null;
  }
}

function words(step: PlanStep): string[] {
  const raw = `${step.title} ${step.action} ${step.symbol ?? ''} ${step.file}`.toLowerCase();
  return [...new Set(raw.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].filter(
    (word) => !['src', 'test', 'tests', 'file', 'новый', 'файл', 'добавить', 'изменить'].includes(word),
  );
}

function resolveImport(from: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = extname(base) === ''
    ? [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}/index.ts`, `${base}/index.tsx`]
    : [base, base.replace(/\.js$/i, '.ts'), base.replace(/\.jsx$/i, '.tsx')];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function directDependencies(target: string, content: string | null, files: ReadonlySet<string>): string[] {
  if (content === null) return [];
  const out: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const resolved = resolveImport(target, match[1] ?? match[2] ?? '', files);
    if (resolved !== null && resolved !== target && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function scoreFile(file: string, content: string, terms: readonly string[], target: string): number {
  if (file === target) return -1;
  let score = dirname(file) === dirname(target) ? 4 : 0;
  const haystack = `${file}\n${content.slice(0, 12_000)}`.toLowerCase();
  for (const term of terms) if (haystack.includes(term)) score += file.toLowerCase().includes(term) ? 5 : 1;
  return score;
}

function declarationExcerpt(content: string, terms: readonly string[]): string {
  const lines = content.split(/\r?\n/);
  const chosen = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const relevant = DECL_RE.test(line) || IMPORT_LINE_RE.test(line) || terms.some((term) => line.toLowerCase().includes(term));
    if (!relevant) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 3); j++) chosen.add(j);
  }
  if (chosen.size === 0) return cap(content, FILE_EXCERPT_BYTES);
  const rendered = [...chosen].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i] ?? ''}`).join('\n');
  return cap(rendered, FILE_EXCERPT_BYTES);
}

function projectApiMap(files: readonly string[], contents: ReadonlyMap<string, string>, target: string): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file === target || TEST_RE.test(file)) continue;
    const declarations = (contents.get(file) ?? '')
      .split(/\r?\n/)
      .filter((line) => /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\b/.test(line))
      .slice(0, 8);
    if (declarations.length > 0) lines.push(`${file}:`, ...declarations.map((line) => `  ${line.trim()}`));
  }
  return cap(lines.join('\n'), API_MAP_BYTES);
}

function importConvention(target: string, files: readonly string[], contents: ReadonlyMap<string, string>): string | null {
  const nearby = files.filter((file) => dirname(file) === dirname(target));
  const imports = nearby.flatMap((file) =>
    (contents.get(file) ?? '').split(/\r?\n/).filter((line) => IMPORT_LINE_RE.test(line) && /['"]\.\.?\//.test(line)),
  );
  if (imports.length === 0) return null;
  const ts = imports.filter((line) => /from\s+['"][^'"]+\.ts['"]|import\s+['"][^'"]+\.ts['"]/.test(line)).length;
  return ts * 2 >= imports.length
    ? 'Локальные импорты в соседних файлах обычно содержат расширение `.ts`.'
    : 'Локальные импорты в соседних файлах обычно пишутся без расширения `.ts`.';
}

/** Builds small, attributable project context for one plan step. No model or vector store is involved. */
export async function buildStepContext(root: string, step: PlanStep, signal?: AbortSignal): Promise<string> {
  const listed = await listSourceFiles(root, SOURCE_LIMIT, signal, { includeDotDirs: false });
  if (signal?.aborted === true) return '';
  const files = listed.files.map((file) => file.replace(/\\/g, '/'));
  const contents = new Map<string, string>();
  for (const file of files) {
    const content = read(root, file);
    if (content !== null) contents.set(file, content);
  }
  const target = step.file.replace(/\\/g, '/');
  const terms = words(step);
  const fileSet = new Set(files);
  const dependencies = directDependencies(target, contents.get(target) ?? null, fileSet);
  const ranked = files
    .filter((file) => !TEST_RE.test(file))
    .map((file) => ({ file, score: scoreFile(file, contents.get(file) ?? '', terms, target) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const related = [...dependencies, ...ranked.map(({ file }) => file)].filter(
    (file, index, all) => all.indexOf(file) === index,
  ).slice(0, 2);

  const testExample = TEST_RE.test(target)
    ? files
        .filter((file) => file !== target && TEST_RE.test(file))
        .map((file) => ({ file, score: (dirname(file) === dirname(target) ? 10 : 0) + scoreFile(file, contents.get(file) ?? '', terms, target) }))
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))[0]?.file ?? null
    : null;

  const sections: string[] = [];
  const convention = importConvention(target, files, contents);
  if (convention !== null) sections.push(`- ${convention}`);
  if (listed.truncated) sections.push(`- Карта проекта ограничена первыми ${SOURCE_LIMIT} исходниками.`);
  const apiMap = projectApiMap(files, contents, target);
  if (apiMap !== '') {
    sections.push(`### Доступные API проекта\n\nИспользуй эти реальные имена и сигнатуры; не выдумывай экспорты.\n\n\`\`\`\n${apiMap}\n\`\`\``);
  }
  for (const file of related) {
    const content = contents.get(file);
    if (content !== undefined) sections.push(`### Связанный исходник: \`${file}\`\n\n\`\`\`\n${declarationExcerpt(content, terms)}\n\`\`\``);
  }
  if (testExample !== null) {
    const content = contents.get(testExample);
    if (content !== undefined) sections.push(`### Пример существующего теста: \`${testExample}\`\n\n\`\`\`\n${cap(content, FILE_EXCERPT_BYTES)}\n\`\`\``);
  }
  if (sections.length === 0) return '';
  // `cap` adds a human-readable truncation marker, so reserve room for that marker.
  return cap(`## Контекст проекта для этого шага\n\n${sections.join('\n\n')}`, STEP_CONTEXT_BYTES - 256);
}
