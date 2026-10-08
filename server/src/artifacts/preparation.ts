/** Версионированная проработка. Старые витки без записи версии остаются на v1. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import type { WitokPaths } from './paths.ts';
import { readArtifact, readDecision } from './artifact.ts';
import { resolvedRequirementsHash } from './resolvedRequirements.ts';
import { intentSections } from './intentSections.ts';
import { claimIdOf } from './claims.ts';
import { parseTables, columnIndex, escapeCell } from '../md/table.ts';
import { parseGuidedJson } from '../exec/guidedJson.ts';
import { extractHumanFacts } from './humanFacts.ts';
import { extractFilesToTouch, forbiddenCodePaths } from './planFiles.ts';
import { extractExplicitSteps } from './planSteps.ts';
import { symlinkEscape } from '../approval/symlink.ts';
import type { PreparationSummary, StageId } from '@sdlc-runner/shared';

export interface PreparationReview {
  sourceHashes?: Record<string, string>;
  fingerprint: string;
  independent: string;
  issues: string[];
  completed: boolean;
}
export interface PreparationReadEvidence {
  path: string;
  sourceHash: string;
  excerptHash: string;
  stage: StageId;
}
export interface PreparationCanonicalV3 {
  requirements?: {
    documentHash: string;
    acceptance: { id: string; behavior: string; procedure: string; expected: string }[];
    basis: { id: string; basis: string; scenario: string; counterexample: string }[];
    constraints: { inScope: string[]; outOfScope: string[]; invariants: string[]; assumptions: string[]; questions: string[] };
  };
  plan?: {
    documentHash: string;
    approach: string;
    filesToTouch: string[];
    fileRoles: { path: string; roles: ('source' | 'target' | 'forbidden' | 'new')[] }[];
    steps: ReturnType<typeof extractExplicitSteps>;
  };
}
export interface PreparationState {
  version: 2 | 3;
  requests: string[];
  review?: PreparationReview;
  readEvidence?: PreparationReadEvidence[];
  structuredTablesRequired?: boolean;
  structuredTablesRendered?: boolean;
  canonical?: PreparationCanonicalV3;
  checkedImplementation?: { revision: number; requestsHash: string; requirementsHash: string; planHash: string; sourceHashes: Record<string, string> };
  planCandidates?: { raw: string; parsed?: unknown; normalized?: string; error?: string }[];
  questionJournal?: {
    version: 1;
    entries: {
      id: string; question: string; origin: string[]; requestHash: string;
      status: 'source' | 'engineering' | 'context' | 'human' | 'protocol' | 'answered' | 'deferred';
      answer: string; reason: string; options: string[];
      sourceHashes: Record<string, string>; citations: { source: string; quote: string }[];
    }[];
  };
  revisions: { revision: number; requestsHash: string; requirementsHash: string; planHash: string; intent: string; clarifications: string; plan: string; approvedBy: string; approvedAt: string }[];
}

function statePath(paths: WitokPaths): string { return join(paths.dir, 'preparation.json'); }
function sectionItems(text: string, heading: string): string[] {
  return section(text, heading).split(/\r?\n/u).map((line) => line.trim().replace(/^[-*+]\s*/u, ''))
    .filter((line) => line !== '' && !/^н\/п\b|^нет\b|^‹/iu.test(line));
}
export function preparation(paths: WitokPaths): PreparationState | null {
  const path = statePath(paths);
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, 'utf8')) as PreparationState;
  if ((state.version !== 2 && state.version !== 3) || !Array.isArray(state.requests) || !Array.isArray(state.revisions)) {
    throw new Error('неподдерживаемая или повреждённая версия проработки');
  }
  if (state.questionJournal !== undefined) {
    const journal = state.questionJournal;
    if (!journal || journal.version !== 1 || !Array.isArray(journal.entries) || !journal.entries.every(entry =>
      entry && ['id', 'question', 'requestHash', 'answer', 'reason'].every(field => typeof entry[field as keyof typeof entry] === 'string') &&
      ['source', 'engineering', 'context', 'human', 'protocol', 'answered', 'deferred'].includes(entry.status) &&
      Array.isArray(entry.origin) && entry.origin.every(value => typeof value === 'string') &&
      Array.isArray(entry.options) && entry.options.every(value => typeof value === 'string') &&
      entry.sourceHashes && typeof entry.sourceHashes === 'object' && !Array.isArray(entry.sourceHashes) && Object.values(entry.sourceHashes).every(value => typeof value === 'string') &&
      Array.isArray(entry.citations) && entry.citations.every(value => value && typeof value.source === 'string' && typeof value.quote === 'string'))) {
      throw new Error('повреждён журнал разрешения вопросов');
    }
  }
  if (state.version === 3 && state.canonical !== undefined) {
    const data = state.canonical;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('повреждены структурированные данные проработки v3');
    const validRequirements = data.requirements === undefined ||
      (typeof data.requirements.documentHash === 'string' && Array.isArray(data.requirements.acceptance) &&
        Array.isArray(data.requirements.basis) && data.requirements.acceptance.every((item) =>
          ['id', 'behavior', 'procedure', 'expected'].every((key) => typeof item[key as keyof typeof item] === 'string')) &&
        data.requirements.basis.every((item) => ['id', 'basis', 'scenario', 'counterexample'].every((key) => typeof item[key as keyof typeof item] === 'string')));
    const validPlan = data.plan === undefined ||
      (typeof data.plan.documentHash === 'string' && typeof data.plan.approach === 'string' &&
        Array.isArray(data.plan.filesToTouch) && data.plan.filesToTouch.every((item) => typeof item === 'string') &&
        Array.isArray(data.plan.fileRoles) && data.plan.fileRoles.every((item) => typeof item.path === 'string' && Array.isArray(item.roles)) &&
        Array.isArray(data.plan.steps));
    if (!validRequirements || !validPlan) throw new Error('повреждены структурированные данные проработки v3');
  }
  return state;
}
export function isPreparationV2(paths: WitokPaths): boolean { return preparation(paths) !== null; }
export function savePreparation(paths: WitokPaths, state: PreparationState): void {
  const path = statePath(paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function requireStructuredPreparationTables(paths: WitokPaths): void {
  const state = preparation(paths);
  if (state === null || state.structuredTablesRequired === true) return;
  state.structuredTablesRequired = true;
  savePreparation(paths, state);
}

export function markStructuredPreparationTablesRendered(paths: WitokPaths): void {
  const state = preparation(paths);
  if (state === null || state.structuredTablesRendered === true) return;
  state.structuredTablesRequired = true;
  state.structuredTablesRendered = true;
  savePreparation(paths, state);
}

/** Запоминает только успешное чтение файла инструментом Runner, не цитату модели. */
export function recordPreparationRead(paths: WitokPaths, stage: StageId, path: string, excerpt: string): void {
  const state = preparation(paths);
  if (state === null || (stage !== 'explore' && stage !== 'ask' && stage !== 'plan')) return;
  try {
    const root = realpathSync(paths.projectRoot);
    const real = realpathSync(resolve(paths.projectRoot, path));
    const rel = relative(root, real).replace(/\\/gu, '/');
    if (rel === '' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').includes('.sdlc')) return;
    const source = readFileSync(real, 'utf8');
    const record: PreparationReadEvidence = {
      path: rel,
      sourceHash: sourceHash(source),
      excerptHash: sourceHash(excerpt),
      stage,
    };
    const evidence = (state.readEvidence ?? []).filter((entry) => entry.path.toLocaleLowerCase() !== rel.toLocaleLowerCase());
    evidence.push(record);
    state.readEvidence = evidence;
    savePreparation(paths, state);
  } catch {
    // A failed, outside-root, or stale path is not evidence.
  }
}

function normalizedPath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '').toLocaleLowerCase();
}

export function preparationReferencedCodePaths(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb|sql|json|yaml|yml)/giu) ?? [];
  return [...new Set(matches.map(normalizedPath))];
}

/** Every existing source/test path named by the requester must be inspected in explore. */
export function preparationExploreEvidenceProblem(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const root = realpathSync(paths.projectRoot);
  const required = new Set<string>();
  for (const request of state.requests) {
    for (const rel of preparationReferencedCodePaths(request)) {
      try {
        const real = realpathSync(resolve(root, rel));
        const actual = relative(root, real).replace(/\\/gu, '/');
        if (actual !== '' && !actual.startsWith('../') && !actual.split('/').includes('.sdlc')) required.add(normalizedPath(actual));
      } catch { /* A new or unavailable path is not a source that can be read yet. */ }
    }
  }
  const read = new Set((state.readEvidence ?? []).map((entry) => normalizedPath(entry.path)));
  const missing = [...required].filter((path) => !read.has(path));
  if (missing.length === 0 && (required.size > 0 || read.size > 0)) return null;
  return missing.length > 0
    ? `до завершения разведки Runner должен передать модели карточки указанных исходников и тестов: ${missing.join(', ')}`
    : 'до завершения разведки Runner должен передать модели хотя бы одну карточку исходника или теста проекта';
}

/** Paths cited in the implementation choice must come from successful Read results. */
export function preparationPlanEvidenceProblem(paths: WitokPaths, planText: string): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const approach = section(planText, 'Подход');
  const plannedPaths = new Set(extractFilesToTouch(planText).map(normalizedPath));
  const implementation = state.checkedImplementation;
  const approved = state.revisions.at(-1);
  const checked = implementation && approved && implementation.revision === approved.revision &&
    implementation.requestsHash === sourceHash(JSON.stringify(state.requests)) &&
    implementation.requestsHash === approved.requestsHash && implementation.requirementsHash === approved.requirementsHash &&
    implementation.requirementsHash === resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text) &&
    implementation.planHash === planContentHash(planText) && implementation.planHash === approved.planHash
    ? new Map(Object.entries(implementation.sourceHashes).map(([path, hash]) => [normalizedPath(path), { path, hash }])) : null;
  if (checked) for (const { path, hash } of checked.values()) {
    if (!plannedPaths.has(normalizedPath(path)) || !implementationSourceMatches(paths, path, hash)) return `реализация ${path} изменилась после проверки guided; повтори проверку актуального кода`;
  }
  const literalCitations = preparationReferencedCodePaths(approach);
  // Module specifiers in a cited export are relative to that source file, not
  // to the project root. Resolve only an unambiguous, known project address.
  const qualifiedApproach = approach.replace(/\bfrom\s+(['"])(\.\.?\/[^'"\r\n]+)\1/gu, (literal, _quote: string, specifier: string) => {
    const candidates = new Set(literalCitations.filter(path => existsSync(resolve(paths.projectRoot, path))).map(path =>
      normalizedPath(relative(paths.projectRoot, resolve(paths.projectRoot, dirname(path), specifier))))
      .filter(path => !path.startsWith('../') && (plannedPaths.has(path) || existsSync(resolve(paths.projectRoot, path)))));
    return candidates.size === 1 ? `from '${[...candidates][0]}'` : literal;
  });
  const allCited = preparationReferencedCodePaths(qualifiedApproach);
  if (allCited.length === 0) return 'в «Подход» укажи файлы и символы, по которым выбрано решение';
  const cited = allCited.filter((path) =>
    existsSync(resolve(paths.projectRoot, path)) || !plannedPaths.has(path));
  const records = new Map((state.readEvidence ?? []).map((entry) => [normalizedPath(entry.path), entry]));
  const newPaths = new Set(extractExplicitSteps(planText).filter(step => step.isNew).map(step => normalizedPath(step.file)));
  const missing = cited.filter((path) => {
    const evidence = records.get(path);
    if (checked?.has(path) && (evidence !== undefined || newPaths.has(path))) return false;
    if (evidence === undefined) return true;
    try {
      const current = readFileSync(resolve(paths.projectRoot, evidence.path), 'utf8');
      return sourceHash(current) !== evidence.sourceHash;
    } catch { return true; }
  });
  return missing.length === 0
    ? null
    : `решение в «Подход» ссылается на непереданные или изменившиеся исходники: ${missing.join(', ')} — используй источники из отчёта разведки и обнови обоснование`;
}

function implementationSourceMatches(paths: WitokPaths, path: string, hash: string): boolean {
  try {
    const root = realpathSync(paths.projectRoot);
    const absolute = resolve(root, path);
    const back = relative(root, absolute);
    if (back.startsWith('..') || isAbsolute(back) || symlinkEscape(root, absolute, []) !== null) return false;
    if (hash === 'missing') return !existsSync(absolute);
    const real = realpathSync(absolute);
    const realBack = relative(root, real);
    return !realBack.startsWith('..') && !isAbsolute(realBack) && sourceHash(readFileSync(real, 'utf8')) === hash;
  } catch { return false; }
}

/** Called only after runtime has checked every guided group against the current bytes. */
export function recordPreparationImplementation(paths: WitokPaths, hashes: Readonly<Record<string, string>>): void {
  const state = preparation(paths);
  const approved = state?.revisions.at(-1);
  if (state?.version !== 3 || !approved) return;
  const requestsHash = sourceHash(JSON.stringify(state.requests));
  const requirementsHash = resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text);
  const planHash = planContentHash(readArtifact(paths.plan).text);
  if (approved.requestsHash !== requestsHash || approved.requirementsHash !== requirementsHash || approved.planHash !== planHash ||
      readDecision(readArtifact(paths.plan).text, 'Одобрение').state !== 'granted') return;
  const planned = new Set(extractFilesToTouch(approved.plan).map(normalizedPath));
  const sourceHashes = Object.fromEntries(Object.entries(hashes).filter(([path]) => planned.has(normalizedPath(path))));
  if (!Object.entries(sourceHashes).every(([path, hash]) => implementationSourceMatches(paths, path, hash))) return;
  savePreparation(paths, { ...state, checkedImplementation: { revision: approved.revision, requestsHash, requirementsHash, planHash, sourceHashes } });
}
/** Только новый intent; открытие старого витка никогда не мигрирует его. */
export function initializePreparation(paths: WitokPaths, request?: string, version: 1 | 2 | 3 = 3): void {
  let state = preparation(paths);
  if (state === null && (version === 1 || existsSync(paths.intent) || existsSync(paths.plan) || existsSync(paths.explorationReport))) return;
  state ??= version === 1 ? null : { version, requests: [], revisions: [] };
  if (state === null) return;
  if (request !== undefined && request.trim() !== '' && state.requests.at(-1) !== request) state.requests.push(request);
  savePreparation(paths, state);
}

/** Refresh v3's machine-readable source data from the validated rendered documents. */
export function syncCanonicalPreparation(paths: WitokPaths): void {
  const state = preparation(paths);
  if (state?.version !== 3) return;
  const intent = readArtifact(paths.intent);
  const plan = readArtifact(paths.plan);
  const acceptanceTable = parseTables(section(intent.text, 'Приёмочный лист'))[0];
  const basisTable = parseTables(section(intent.text, 'Основания и сценарии'))[0];
  const acceptance = acceptanceTable === undefined ? [] : acceptanceTable.rows.map((row) => ({
    id: (row[columnIndex(acceptanceTable.header, 'id')] ?? '').replace(/`/gu, '').trim(),
    behavior: row[columnIndex(acceptanceTable.header, 'Пункт')] ?? '',
    procedure: ((row[columnIndex(acceptanceTable.header, 'Как проверить (процедура + критерий)')] ?? '').match(/Процедура:\s*(.*?)(?:\.\s*Ожидаемо:|$)/iu)?.[1] ?? '').trim(),
    expected: ((row[columnIndex(acceptanceTable.header, 'Как проверить (процедура + критерий)')] ?? '').match(/Ожидаемо:\s*(.*)$/iu)?.[1] ?? '').trim(),
  }));
  const basis = basisTable === undefined ? [] : basisTable.rows.map((row) => ({
    basis: row[columnIndex(basisTable.header, 'Основание')] ?? '',
    scenario: row[columnIndex(basisTable.header, 'Сценарий')] ?? '',
    counterexample: row[columnIndex(basisTable.header, 'Контрпример')] ?? '',
    id: (row[columnIndex(basisTable.header, 'ID')] ?? '').replace(/`/gu, '').trim(),
  }));
  const inScope = sectionItems(intent.text, 'Что делаем');
  const outOfScope = sectionItems(intent.text, 'Чего не делаем');
  const invariants = sectionItems(intent.text, 'Инварианты');
  const assumptions = sectionItems(intent.text, 'Предположения');
  const questions = sectionItems(intent.text, 'Открытые вопросы');
  const targetPaths = plan.exists ? extractFilesToTouch(plan.text) : [];
  const forbiddenPaths = forbiddenCodePaths(section(intent.text, 'Чего не делаем'));
  const sourcePaths = (state.readEvidence ?? []).map((entry) => entry.path);
  const allPaths = [...new Set([...sourcePaths, ...targetPaths, ...forbiddenPaths])];
  const canonical: PreparationCanonicalV3 = {
    ...(acceptance.length > 0 && basis.length > 0 ? {
      requirements: {
        documentHash: sourceHash(intent.text), acceptance, basis,
        constraints: { inScope, outOfScope, invariants, assumptions, questions },
      },
    } : {}),
    ...(plan.exists ? {
      plan: {
        documentHash: sourceHash(plan.text),
        approach: section(plan.text, 'Подход'),
        filesToTouch: targetPaths,
        fileRoles: allPaths.map((path) => ({
          path,
          roles: [
            ...(sourcePaths.includes(path) ? ['source' as const] : []),
            ...(targetPaths.includes(path) ? ['target' as const] : []),
            ...(forbiddenPaths.includes(path) ? ['forbidden' as const] : []),
            ...(!existsSync(resolve(paths.projectRoot, path)) ? ['new' as const] : []),
          ],
        })),
        steps: extractExplicitSteps(plan.text),
      },
    } : {}),
  };
  if (JSON.stringify(state.canonical ?? {}) !== JSON.stringify(canonical)) {
    state.canonical = canonical;
    savePreparation(paths, state);
  }
}

export function section(text: string, name: string): string { return intentSections(text).get(name)?.trim() ?? ''; }
export type PreparationTableKind = 'acceptance' | 'basis';
export interface PreparationTableNormalization { text: string; changed: boolean; problem: string | null; }

function canonicalizeMarkdownClaimTables(intent: string): string | null {
  const specs = [
    { kind: 'acceptance' as const, title: 'Приёмочный лист' },
    { kind: 'basis' as const, title: 'Основания и сценарии' },
  ];
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const spec of specs) {
    const lines = intent.match(/.*(?:\r?\n|$)/gu) ?? [];
    let offset = 0;
    let sectionStart = -1;
    let sectionEnd = lines.length;
    for (let index = 0; index < lines.length; index++) {
      if (sectionStart < 0 && /^#{1,2}\s+/u.test(lines[index]!) && lines[index]!.toLocaleLowerCase().includes(spec.title.toLocaleLowerCase())) sectionStart = index + 1;
      else if (sectionStart >= 0 && /^#{1,2}\s+/u.test(lines[index]!)) { sectionEnd = index; break; }
    }
    if (sectionStart < 0) return null;
    let tableStart = -1;
    let tableEnd = -1;
    let lineStartOffset = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (index >= sectionStart && index < sectionEnd && /^\s*\|/u.test(line)) {
        if (tableStart < 0) { tableStart = index; lineStartOffset = offset; }
        tableEnd = index;
      } else if (tableStart >= 0) break;
      offset += line.length;
    }
    if (tableStart < 0) return null;
    const raw = lines.slice(tableStart, tableEnd + 1).join('');
    const table = parseTables(raw)[0];
    if (table === undefined) return null;
    const headers = table.header.map((header) => header.replace(/`/gu, '').trim().toLocaleLowerCase());
    const col = (matcher: RegExp, last = false): number => {
      const matches = headers.map((header, index) => matcher.test(header) ? index : -1).filter((index) => index >= 0);
      return matches.length === 0 ? -1 : last ? matches.at(-1)! : matches[0]!;
    };
    let rows: Record<string, string>[];
    if (spec.kind === 'acceptance') {
      const id = col(/^id$/u), behavior = col(/пункт|поведен/u), check = col(/провер/u);
      if ([id, behavior, check].some((index) => index < 0)) return null;
      rows = table.rows.map((row) => {
        const rendered = /^Процедура:\s*([\s\S]*?)\.\s*Ожидаемо:\s*([\s\S]*)$/u.exec(row[check] ?? '');
        return {
          id: (row[id] ?? '').replace(/`/gu, '').trim(),
          behavior: row[behavior] ?? '',
          procedure: rendered?.[1] ?? row[check] ?? '',
          expected: rendered?.[2] ?? row[behavior] ?? '',
        };
      });
    } else {
      const basis = col(/основан/u), scenario = col(/сценари/u), counterexample = col(/контрпример/u), id = col(/^id$/u, true);
      if ([basis, scenario, counterexample, id].some((index) => index < 0)) return null;
      rows = table.rows.map((row) => ({
        id: (row[id] ?? '').replace(/`/gu, '').trim(),
        basis: row[basis] ?? '',
        scenario: row[scenario] ?? '',
        counterexample: row[counterexample] ?? '',
      }));
    }
    const marker = `<!-- sdlc-json:${spec.kind}:start -->\n${JSON.stringify(rows)}\n<!-- sdlc-json:${spec.kind}:end -->`;
    const endOffset = lines.slice(0, tableEnd + 1).join('').length;
    const trailingNewline = /\r?\n$/u.exec(raw)?.[0] ?? '';
    replacements.push({ start: lineStartOffset, end: endOffset, text: marker + trailingNewline });
  }
  let result = intent;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}

/** Convert model-authored JSON arrays into Markdown tables owned by the Runner. */
function clampLineRange(lines: readonly unknown[], max: number): [number, number] {
  const nums = lines.map(v => typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : NaN).filter(n => !Number.isNaN(n));
  if (nums.length < 2) return [1, Math.min(1, max)];
  const start = Math.max(1, Math.min(nums[0]!, max));
  const end = Math.max(start, Math.min(nums[1]!, max));
  return [start, end];
}

function lenientAcceptanceRow(row: unknown): Record<string, string> | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = String(r.id ?? '').replace(/`/gu, '').trim();
  const behavior = String(r.behavior ?? '').trim();
  const procedure = String(r.procedure ?? '').trim();
  const expected = String(r.expected ?? '').trim();
  if (!/^claim-\d+$/u.test(id) || behavior === '' || (procedure === '' && expected === '')) return null;
  return { id, behavior, procedure, expected: expected || procedure, };
}

function lenientBasisRow(row: unknown, requests: readonly string[]): Record<string, string> | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const id = String(r.id ?? '').replace(/`/gu, '').trim();
  const scenario = String(r.scenario ?? '').trim();
  const counterexample = String(r.counterexample ?? '').trim();
  if (!/^claim-\d+$/u.test(id) || (scenario === '' && counterexample === '')) return null;
  const rawBasis = r.basis;
  let basis = '';
  if (typeof rawBasis === 'string') {
    basis = rawBasis.trim();
  } else if (typeof rawBasis === 'object' && rawBasis !== null && !Array.isArray(rawBasis)) {
    const b = rawBasis as Record<string, unknown>;
    const file = String(b.file ?? 'request-1');
    const index = Number(/^request-(\d+)$/u.exec(file)?.[1]);
    const request = Number.isInteger(index) && index >= 1 ? requests[index - 1] ?? requests[0] : requests[0];
    const requestLabel = request === requests[0] ? 'request-1' : file;
    const max = Math.max(1, (request ?? '').split('\n').length);
    const [start, end] = clampLineRange(Array.isArray(b.lines) ? b.lines : [], max);
    basis = `${requestLabel}:L${start}-L${end}`;
  }
  return { id, basis: basis || 'н/п — источник не удалось проверить', scenario, counterexample };
}

function deriveBasisRow(acceptanceRow: Record<string, string>, requests: readonly string[]): Record<string, string> {
  const behavior = acceptanceRow.behavior ?? '';
  const request = requests[0] ?? '';
  const lineCount = request.split('\n').length;
  const basis = request ? `request-1:L1-L${Math.max(1, lineCount)}` : 'н/п — источник не удалось проверить';
  return {
    id: acceptanceRow.id!,
    basis,
    scenario: `Когда ${behavior}`,
    counterexample: `Когда ${behavior} не требуется`,
  };
}

function renderPreparationTable(kind: PreparationTableKind, rows: Record<string, string>[]): string {
  const headers = kind === 'acceptance'
    ? ['ID', 'Пункт', 'Как проверить (процедура + критерий)']
    : ['Основание', 'Сценарий', 'Контрпример', 'ID'];
  const cell = (value: string): string => {
    const flat = value.replace(/[\r\n]+/gu, ' ');
    return escapeCell(flat.split('`').length % 2 === 1 ? flat : `${flat}\``);
  };
  const lines = [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => kind === 'acceptance'
      ? `| ${cell(row.id!)} | ${cell(row.behavior!)} | ${cell(`Процедура: ${row.procedure!}. Ожидаемо: ${row.expected!}`)} |`
      : `| ${cell(row.basis!)} | ${cell(row.scenario!)} | ${cell(row.counterexample!)} | ${cell(row.id!)} |`),
  ];
  return lines.join('\n');
}

export function normalizePreparationTables(intent: string, required = false, requests: readonly string[] = []): PreparationTableNormalization {
  const specs: { kind: PreparationTableKind; fields: string[]; headers: string[] }[] = [
    { kind: 'acceptance', fields: ['id', 'behavior', 'procedure', 'expected'], headers: ['ID', 'Пункт', 'Как проверить (процедура + критерий)'] },
    { kind: 'basis', fields: ['id', 'basis', 'scenario', 'counterexample'], headers: ['Основание', 'Сценарий', 'Контрпример', 'ID'] },
  ];
  let text = intent;
  let changed = false;
  if (required && !intent.includes('sdlc-json:acceptance:start') && !intent.includes('sdlc-json:basis:start')) {
    const legacy = canonicalizeMarkdownClaimTables(intent);
    if (legacy !== null) return normalizePreparationTables(legacy, true, requests);
  }
  const rendered = new Map<PreparationTableKind, Record<string, string>[]>();
  let basisFailed = false;
  for (const spec of specs) {
    const marker = new RegExp(`<!--\\s*sdlc-json:${spec.kind}:start\\s*-->([\\s\\S]*?)<!--\\s*sdlc-json:${spec.kind}:end\\s*-->`, 'u');
    const match = marker.exec(text);
    if (match === null) {
      if (spec.kind === 'basis') basisFailed = true;
      continue;
    }
    const payload = (match[1] ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    let rows: unknown;
    try { rows = JSON.parse(payload); } catch {
      try { rows = parseGuidedJson(payload); } catch {
        if (spec.kind === 'basis') { basisFailed = true; continue; }
        return { text, changed, problem: `JSON-блок ${spec.kind} должен содержать непустой JSON-массив объектов с полями: ${spec.fields.join(', ')}.` };
      }
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      if (spec.kind === 'basis') { basisFailed = true; continue; }
      return { text, changed, problem: `JSON-блок ${spec.kind} должен быть непустым массивом объектов с полями: ${spec.fields.join(', ')}.` };
    }
    const parser = spec.kind === 'acceptance' ? lenientAcceptanceRow : (row: unknown) => lenientBasisRow(row, requests);
    const typedRows = rows.map(parser).filter((row): row is Record<string, string> => row !== null);
    if (typedRows.length === 0) {
      if (spec.kind === 'basis') { basisFailed = true; continue; }
      return { text, changed, problem: `JSON-массив ${spec.kind} не содержит валидных строк; проверь поля ${spec.fields.join(', ')}.` };
    }
    const ids = typedRows.map((row) => row.id!);
    if (ids.some((id) => !/^claim-\d+$/u.test(id)) || new Set(ids).size !== ids.length) {
      if (spec.kind === 'basis') { basisFailed = true; continue; }
      return { text, changed, problem: `В JSON-блоке ${spec.kind} укажи уникальные ID формата claim-N.` };
    }
    rendered.set(spec.kind, typedRows);
    text = text.replace(marker, renderPreparationTable(spec.kind, typedRows));
    changed = true;
  }
  const acceptance = rendered.get('acceptance');
  if (acceptance !== undefined && (basisFailed || !rendered.has('basis'))) {
    const basisRows = acceptance.map((row) => deriveBasisRow(row, requests));
    rendered.set('basis', basisRows);
    const basisMarkdown = renderPreparationTable('basis', basisRows);
    const basisMarker = /<!--\s*sdlc-json:basis:start\s*-->[\s\S]*?<!--\s*sdlc-json:basis:end\s*-->/u;
    if (basisMarker.test(text)) {
      text = text.replace(basisMarker, basisMarkdown);
    } else if (/##\s+Основания\s+и\s+сценарии/i.test(text)) {
      const sectionMatch = /##\s+Основания\s+и\s+сценарии[^\n]*\n?/i.exec(text);
      if (sectionMatch !== null) {
        text = text.slice(0, sectionMatch.index + sectionMatch[0].length) + basisMarkdown + '\n\n' + text.slice(sectionMatch.index + sectionMatch[0].length);
      } else {
        text += '\n\n' + basisMarkdown;
      }
    } else {
      text += '\n\n## Основания и сценарии\n\n' + basisMarkdown;
    }
    changed = true;
  }
  if (required && acceptance === undefined) {
    return { text: intent, changed: false, problem: 'Восстанови оба блока JSON-маркерами sdlc-json:acceptance и sdlc-json:basis; не записывай эти данные Markdown-таблицами.' };
  }
  if (required && !rendered.has('basis')) {
    return { text: intent, changed: false, problem: 'Восстанови JSON-маркер sdlc-json:basis с корректным массивом объектов, чтобы Runner мог построить таблицу оснований.' };
  }
  const basis = rendered.get('basis');
  if (acceptance !== undefined && basis !== undefined) {
    const left = new Set(acceptance.map((row) => row.id));
    const right = new Set(basis.map((row) => row.id));
    if (left.size !== right.size || [...left].some((id) => !right.has(id))) {
      return { text: intent, changed: false, problem: 'JSON-блоки acceptance и basis должны содержать одинаковый набор claim-N, по одной строке на ID.' };
    }
  }
  return { text, changed, problem: null };
}

function substantive(text: string): boolean { return text.trim().length > 0 && !/[‹›]/u.test(text); }
function hasSubstantiveIntentLabel(text: string, labels: readonly string[]): boolean {
  return labels.some((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:?\\s*([^\\n]*)`, 'u').exec(text);
    return match !== null && substantive(match[1] ?? '');
  });
}
export function researchProblem(intent: string): string | null {
  const required: { name: string; labels: string[] }[] = [
    { name: 'Коротко', labels: ['Коротко', 'Кратко', 'Назначение', 'Цель'] },
    { name: 'Зачем', labels: ['Зачем', 'Проблема', 'Контекст'] },
    { name: 'Что делаем', labels: ['Что делаем', 'Желаемый результат', 'Что должно получиться', 'Требования'] },
    { name: 'Чего не делаем', labels: ['Чего не делаем', 'Что не делаем', 'Не делаем', 'Границы', 'Ограничения'] },
  ];
  const sections = intentSections(intent);
  for (const field of required) {
    const hasSection = field.labels.some((label) => substantive(sections.get(label) ?? ''));
    if (!hasSection && !hasSubstantiveIntentLabel(intent, field.labels)) {
      return `для исследования заполни «${field.name}»: цель, результат и границы`;
    }
  }
  // A research question is the reason to enter `explore`, not a blocker to it.
  // Unresolved behavioral questions are checked after exploration in `requirementProblem`.
  return null;
}
/** Неблокирующие вопросы разрешено сохранять открытыми. Непомеченный вопрос блокирует реализацию. */
export function blockingQuestions(text: string, researchOnly = false): boolean {
  return text.split(/\r?\n/u).some((line) => /^\s*[-*+]\s*\[\s*\]/u.test(line) &&
    (researchOnly ? /\[исследование\]/iu.test(line) : !/\[неблокирующий\]/iu.test(line)));
}
export function requirementProblem(intent: string, canonical?: PreparationCanonicalV3['requirements']): string | null {
  const first = researchProblem(intent);
  if (first !== null) return first;
  if (blockingQuestions(intent)) return 'остались существенные вопросы: вернись к уточнениям до реализации';
  if (canonical !== undefined && canonical.documentHash !== sourceHash(intent)) return 'структурированные требования устарели относительно intent; повтори нормализацию требований';
  const claims = canonical?.acceptance.map((item) => [item.id, item.behavior, `${item.procedure} ${item.expected}`]) ??
    parseTables(section(intent, 'Приёмочный лист')).flatMap((t) => t.rows);
  if (claims.length === 0) return 'нет сценариев приёмки';
  const ids = new Set<string>();
  for (const row of claims) {
    const id = claimIdOf('| ' + row.join(' | ') + ' |');
    if (id === null || ids.has(id) || !substantive(row[1] ?? '') || !substantive(row[2] ?? '') ||
        (canonical !== undefined && canonical.acceptance.some((item) => item.id === id && (!substantive(item.procedure) || !substantive(item.expected))))) {
      return 'приёмка: нужны уникальные claim-N, поведение и процедура с ожидаемым результатом';
    }
    ids.add(id);
  }
  if (canonical !== undefined) {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const row of canonical.basis) {
      if (!ids.has(row.id)) { problems.push(`${row.id}: основание для несуществующего требования`); continue; }
      if (seen.has(row.id)) { problems.push(`${row.id}: дубль основания`); continue; }
      seen.add(row.id);
      const missing = [!substantive(row.basis) && 'основание', !substantive(row.scenario) && 'сценарий', !substantive(row.counterexample) && 'контрпример']
        .filter((field): field is string => field !== false);
      if (missing.length) problems.push(`${row.id}: заполни ${missing.join(', ')}`);
    }
    const uncovered = [...ids].filter(id => !seen.has(id));
    if (uncovered.length) problems.push(`нет основания, сценария и контрпримера: ${uncovered.join(', ')}`);
    return problems.length === 0 ? null : `основания: ${problems.join('; ')}`;
  }
  const table = parseTables(section(intent, 'Основания и сценарии'))[0];
  const labels = ['ID', 'Основание', 'Сценарий', 'Контрпример'];
  if (table === undefined || labels.some((label) => columnIndex(table.header, label) < 0) || columnIndex(table.header, 'ID') !== 3) return 'добавь «Основания и сценарии»: Основание | Сценарий | Контрпример | ID';
  const columns = labels.map((label) => columnIndex(table.header, label));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const row of table.rows) {
    const id = (row[columns[0]!] ?? '').replace(/`/gu, '').trim();
    if (!ids.has(id)) { problems.push(`${id}: основание для несуществующего требования`); continue; }
    if (seen.has(id)) { problems.push(`${id}: дубль основания`); continue; }
    seen.add(id);
    const missing = ['основание', 'сценарий', 'контрпример'].filter((_, i) => !substantive(row[columns[i + 1]!] ?? ''));
    if (missing.length) problems.push(`${id}: заполни ${missing.join(', ')}`);
  }
  const uncovered = [...ids].filter(id => !seen.has(id));
  if (uncovered.length) problems.push(`нет основания, сценария и контрпримера: ${uncovered.join(', ')}`);
  return problems.length === 0 ? null : `основания: ${problems.join('; ')}`;
}

export function planContentHash(plan: string): string {
  // Подпись добавляется после проверки; весь остальной план связан с одобрением.
  return createHash('sha256').update(plan.replace(/^.*\*\*Одобрение:\*\*.*$/gmu, '').replace(/\r\n?/gu, '\n').trimEnd()).digest('hex');
}
export function preparationFingerprint(paths: WitokPaths): string {
  return createHash('sha256').update(JSON.stringify({
    requests: preparation(paths)?.requests,
    readEvidence: preparation(paths)?.readEvidence ?? [],
    requirements: resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text),
    plan: planContentHash(readArtifact(paths.plan).text),
    research: readArtifact(paths.explorationReport).text,
  })).digest('hex');
}
export function preparationReviewProblem(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const problem = requirementProblem(readArtifact(paths.intent).text,
    state.version === 3 && state.structuredTablesRendered === true ? state.canonical?.requirements : undefined);
  if (problem !== null) return problem;
  const planArtifact = readArtifact(paths.plan);
  if (planArtifact.exists) {
    const sourceProblem = preparationPlanEvidenceProblem(paths, planArtifact.text);
    if (sourceProblem !== null) return sourceProblem;
  }
  const review = state.review;
  if (review === undefined) return 'независимая проверка ещё не проводилась; заверши проверку требований и плана';
  if (!review.completed) {
    const diagnostic = review.issues.find((issue) => issue.trim() !== '');
    return diagnostic === undefined
      ? 'независимая проверка не завершилась; повтори проверку требований и плана'
      : `независимая проверка не завершилась: ${diagnostic}`;
  }
  if (review.fingerprint !== preparationFingerprint(paths) ||
      (approvedPreparationProblem(paths) !== null && !reviewSourcesCurrent(paths, review))) return 'требования, план или исходники изменились после ревью; повтори проверку актуальной редакции';
  return review.issues.length === 0 ? null : 'проработка требует исправлений:\n' + review.issues.map((issue) => '- ' + issue).join('\n');
}

export function sourceHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function reviewSourcesCurrent(paths: WitokPaths, review: PreparationReview): boolean {
  try {
    const root = realpathSync(paths.projectRoot);
    return Object.entries(review.sourceHashes ?? {}).every(([path, hash]) => {
      const real = realpathSync(join(root, path));
      const back = relative(root, real);
      return !back.startsWith('..') && !isAbsolute(back) && sourceHash(readFileSync(real, 'utf8')) === hash;
    });
  } catch { return false; }
}
export function approvePreparation(paths: WitokPaths, operator: string, now: Date): void {
  const state = preparation(paths);
  if (state === null) return;
  syncCanonicalPreparation(paths);
  const current = preparation(paths)!;
  const problem = preparationReviewProblem(paths);
  if (problem !== null) throw new Error(problem);
  const intent = readArtifact(paths.intent).text;
  const clarifications = readArtifact(paths.clarificationReport).text;
  const plan = readArtifact(paths.plan).text;
  const previous = current.revisions.at(-1);
  const requestsHash = sourceHash(JSON.stringify(current.requests));
  if (previous?.requestsHash === requestsHash && previous.requirementsHash === resolvedRequirementsHash(intent, clarifications) && previous.planHash === planContentHash(plan)) return;
  current.revisions.push({ revision: current.revisions.length + 1, requestsHash, requirementsHash: resolvedRequirementsHash(intent, clarifications), planHash: planContentHash(plan), intent, clarifications, plan, approvedBy: operator, approvedAt: now.toISOString() });
  savePreparation(paths, current);
}
export function approvedPreparationProblem(paths: WitokPaths): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  const planArtifact = readArtifact(paths.plan);
  if (planArtifact.exists) {
    const sourceProblem = preparationPlanEvidenceProblem(paths, planArtifact.text);
    if (sourceProblem !== null) return sourceProblem;
  }
  const approved = state.revisions.at(-1);
  if (approved === undefined) return 'актуальная редакция требований и плана ещё не подтверждена человеком';
  if (readDecision(readArtifact(paths.plan).text, 'Одобрение').state !== 'granted' ||
      approved.requestsHash !== sourceHash(JSON.stringify(state.requests)) ||
      approved.requirementsHash !== resolvedRequirementsHash(readArtifact(paths.intent).text, readArtifact(paths.clarificationReport).text) ||
      approved.planHash !== planContentHash(readArtifact(paths.plan).text)) return 'требования или план изменились после подтверждения; вернись к проработке и подтверди новую редакцию';
  return null;
}
function approvedClaims(intent: string): Map<string, string> {
  const table = parseTables(section(intent, 'Приёмочный лист'))[0];
  if (table === undefined) return new Map();
  const idColumn = columnIndex(table.header, 'id');
  const pointColumn = columnIndex(table.header, 'пункт');
  const checkColumn = columnIndex(table.header, 'как проверить');
  if (idColumn < 0 || pointColumn < 0 || checkColumn < 0) return new Map();
  const claims = new Map<string, string>();
  for (const row of table.rows) {
    const id = claimIdOf(`| ${row.join(' | ')} |`);
    if (id === null) continue;
    claims.set(id, `${row[pointColumn] ?? ''} — ${row[checkColumn] ?? ''}`.trim());
  }
  return claims;
}

function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[фрагмент сокращён; полная редакция сохранена рантаймом]`;
}

/**
 * Дополнительный контекст, которого нет во входных артефактах конкретного этапа.
 * Сам intent/exploration/clarification/plan уже подаются через `stageInputs`; повторная
 * передача всех документов здесь раздувала каждый запрос и историю цикла. Оставляем только
 * сведения о предыдущем подтверждении, ответы человека на этапе вопросов и замечания
 * независимой проверки плана.
 */
export function preparationContext(paths: WitokPaths, stage: StageId): string | null {
  const state = preparation(paths);
  if (state === null) return null;
  if (!['intent', 'ask', 'plan'].includes(stage)) return null;
  const last = state.revisions.at(-1);
  const parts: string[] = [];
  if (stage === 'intent') {
    if (last === undefined) return null;
    const claims = approvedClaims(last.intent);
    parts.push(`## Предыдущие подтверждённые требования (редакция ${last.revision})`);
    parts.push(claims.size === 0
      ? 'Приёмочных требований в предыдущей редакции не было.'
      : [...claims].map(([id, text]) => `- ${id}: ${text}`).join('\n'));
    parts.push('На повторном входе сначала прочитай текущий intent.md и сохраняй ID неизменённых требований.');
  }
  if (stage === 'ask') {
    const clarification = readArtifact(paths.clarificationReport);
    const facts = extractHumanFacts(clarification.exists ? clarification.text : '');
    if (facts.length === 0) return null;
    parts.push('## Уже записанные ответы человека (дословные факты; не спрашивай повторно)');
    parts.push(facts.map((fact, i) => [
      `${i + 1}. Вопрос: ${fact.question}`,
      `Ответ: ${fact.answer}`,
      ...(fact.changed === '' ? [] : [`Отражение в задаче: ${fact.changed}`]),
    ].join('\n')).join('\n\n'));
  }
  if (stage === 'plan') {
    if (last !== undefined) {
      const previous = approvedClaims(last.intent);
      const currentIntent = readArtifact(paths.intent).text;
      const current = approvedClaims(currentIntent);
      const ids = new Set([...previous.keys(), ...current.keys()]);
      const changes = [...ids].filter((id) => previous.get(id) !== current.get(id));
      parts.push(`## Сверка с последней подтверждённой редакцией ${last.revision}`);
      parts.push(changes.length === 0
        ? 'Тексты требований claim-N не изменились.'
        : changes.map((id) => {
            const before = previous.get(id);
            const after = current.get(id);
            if (before === undefined) return `- Добавлен ${id}: ${after}`;
            if (after === undefined) return `- Удалён ${id}: ${before}`;
            return `- Изменён ${id}: было «${before}»; стало «${after}»`;
          }).join('\n'));
      const oldSections = intentSections(last.intent);
      const newSections = intentSections(currentIntent);
      const sectionChanges = [...new Set([...oldSections.keys(), ...newSections.keys()])]
        .filter((name) => name !== 'Приёмочный лист' && oldSections.get(name) !== newSections.get(name));
      if (sectionChanges.length > 0) {
        parts.push('Изменения остальных разделов intent (фрагменты ограничены; текущий intent.md — источник полной редакции):');
        parts.push(sectionChanges.map((name) => {
          const before = oldSections.get(name);
          const after = newSections.get(name);
          if (before === undefined) return `- Добавлен раздел «${name}»: ${bounded(after ?? '', 700)}`;
          if (after === undefined) return `- Удалён раздел «${name}»: ${bounded(before, 700)}`;
          return `- Изменён раздел «${name}»: было «${bounded(before, 700)}»; стало «${bounded(after, 700)}»`;
        }).join('\n'));
      }
    } else {
      parts.push('Это первая редакция; сравнивай требования с исходным запросом и объясни уточнения в плане.');
    }
    if (state.review !== undefined && state.review.issues.length > 0) {
      parts.push('## Замечания независимой проверки к прошлой редакции плана');
      parts.push(state.review.issues.map((issue, i) => `${i + 1}. ${bounded(issue, 1_000)}`).join('\n'));
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** Для решения человека: текущая редакция и фактические отличия от последней одобренной. */
export function preparationSummary(paths: WitokPaths): PreparationSummary | null {
  syncCanonicalPreparation(paths);
  const state = preparation(paths);
  if (state === null) return null;
  const requirements = readArtifact(paths.intent).text;
  const last = state.revisions.at(-1);
  const before = intentSections(last?.intent ?? '');
  const after = intentSections(requirements);
  const confirmed = approvedPreparationProblem(paths) === null;
  const problem = preparationReviewProblem(paths);
  return {
    version: state.version, ...(state.canonical === undefined ? {} : { canonical: state.canonical }), fingerprint: preparationFingerprint(paths), revision: state.revisions.length + (confirmed ? 0 : 1), confirmed,
    readyToApprove: problem === null, issues: problem === null ? [] : [problem], requirements,
    changes: [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).map((name) => ({ section: name, before: before.get(name) ?? '', after: after.get(name) ?? '' })),
  };
}
