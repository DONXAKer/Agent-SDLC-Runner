import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { GateRunResult, StageId, Verdict } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';
import { SDLC_CONSTANTS } from '../config/constants.ts';
import { parseTables } from '../md/table.ts';
import { atomicJson, assertPlainPath, evidenceFile, fileHash, protectedRunDir, sha256 } from './protectedStore.ts';
import type { ReviewV1 } from './stages/verify/reviewValidate.ts';
import { manualClaimIds } from '../verdict/collect.ts';

const text = z.string().min(1);
const ref = z.object({ path: text, anchor: text }).strict();
const evidence = z.object({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), anchor: z.string().optional() }).strict();
const reviewFinding = (kinds: [string, ...string[]]) => z.object({ kind: z.enum(kinds), summary: text, evidence: z.array(ref).min(1) }).strict();
const reviewSchema = z.object({
  schema_version: z.literal('agent-sdlc/verify-review/v1'),
  claims: z.array(z.object({ id: z.string().regex(/^claim-[1-9][0-9]*$/), status: z.enum(['passed', 'failed', 'uncertain', 'manual']), evidence: z.array(ref), remediation: z.string() }).strict()),
  findings: z.array(reviewFinding(['mismatch', 'uncovered_behavior'])), scope: z.array(reviewFinding(['scope'])),
  invariants: z.array(reviewFinding(['invariant'])), regressions: z.array(reviewFinding(['regression'])), retry_instruction: z.string(),
}).strict();

export const canonicalStateSchema = z.object({
  schema_version: z.literal('agent-sdlc/state/v1'), slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  stage: z.enum(['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff', 'blocked']),
  claims: z.array(z.object({ id: z.string().regex(/^claim-[1-9][0-9]*$/), text, verification: text, tags: z.array(z.string()).optional() }).strict()),
  gates: z.array(z.object({ name: text, stage: z.number().int().min(1).max(7), enabled: z.boolean(), status: z.enum(['passed', 'failed', 'skipped', 'debt']), result: z.string().optional(), evidence: z.array(evidence).optional() }).strict()),
  attempts: z.array(z.object({ chunk: z.number().int().min(1), number: z.number().int().min(1), status: z.enum(['open', 'passed', 'failed', 'blocked_env', 'escalated']), diff: evidence.optional(), tests: evidence.optional() }).strict()),
  decisions: z.array(z.object({ kind: text, by: text, at: z.iso.datetime({ offset: true }), value: text }).strict()),
  verification: z.object({ passed: z.boolean(), action: z.enum(['continue', 'retry', 'blocked_env', 'escalate']), review: reviewSchema, retry_instruction: z.string().optional() }).strict(),
  migration: z.object({ source: z.literal('legacy_markdown'), artifacts: z.array(text), unresolved: z.array(text) }).strict().optional(),
}).strict();
export type CanonicalState = z.infer<typeof canonicalStateSchema>;
export interface StateReceipt { hash: string; chunk: number; attempt: number; reasons: string[]; patchSha: string | null; committedSha: string | null; gateHash: string | null; }
const stateFile = (paths: WitokPaths) => join(paths.dir, 'state.json');
const receiptFile = (paths: WitokPaths) => join(protectedRunDir(paths.projectRoot, paths.slug), 'state-receipt.json');
const pendingFile = (paths: WitokPaths) => join(protectedRunDir(paths.projectRoot, paths.slug), 'state-pending.json');
export const hasCanonicalState = (paths: WitokPaths): boolean => lstatSync(stateFile(paths), { throwIfNoEntry: false }) !== undefined;

export function validateCanonicalState(value: unknown): CanonicalState {
  const state = canonicalStateSchema.parse(value);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(state.claims.map(c => c.id)) || !unique(state.verification.review.claims.map(c => c.id)) ||
      !unique(state.gates.map(g => `${g.stage}:${g.name}`)) || !unique(state.attempts.map(a => `${a.chunk}:${a.number}`))) throw new Error('Дубли в каноническом состоянии');
  const claims = new Map(state.claims.map(c => [c.id, c]));
  const reviewed = state.verification.review.claims;
  if (reviewed.length !== claims.size || reviewed.some(c => !claims.has(c.id))) throw new Error('Ревью не покрывает канонические claims');
  if (reviewed.some(c => c.status === 'passed' && !c.evidence.length || c.status === 'manual' && !claims.get(c.id)?.tags?.includes('manual'))) throw new Error('Статус claim не подтверждён');
  const verification = state.verification;
  if (verification.passed !== (verification.action === 'continue')) throw new Error('Противоречие passed/action');
  if (verification.passed) {
    if (!['verify', 'handoff'].includes(state.stage) || !claims.size || reviewed.some(c => ['failed', 'uncertain'].includes(c.status)) ||
        ['findings', 'scope', 'invariants', 'regressions'].some(k => (verification.review[k as 'findings']).length) || state.migration?.unresolved.length) throw new Error('Зелёное состояние противоречит проверкам');
    const limit = state.stage === 'handoff' ? 7 : 6;
    for (const name of SDLC_CONSTANTS.mandatory_gates) {
      if (!state.gates.some(g => g.name === name && g.stage === 6 && g.enabled)) throw new Error(`Нет обязательного гейта: ${name}`);
    }
    if (state.gates.some(g => g.enabled && g.stage <= limit && (g.status !== 'passed' || !g.evidence?.length))) throw new Error('Гейт не имеет положительного свидетельства');
  }
  return state;
}

export function readCanonicalState(paths: WitokPaths): { state: CanonicalState; receipt: StateReceipt } | null {
  if (!hasCanonicalState(paths)) {
    try { protectedRunDir(paths.projectRoot, paths.slug); } catch { return null; }
  }
  if (existsSync(pendingFile(paths))) {
    assertPlainPath(pendingFile(paths)); assertPlainPath(stateFile(paths));
    const pending = JSON.parse(readFileSync(pendingFile(paths), 'utf8')) as { previousHash: string | null; state: CanonicalState; receipt: StateReceipt };
    validateCanonicalState(pending.state);
    const desired = sha256(JSON.stringify(pending.state, null, 2) + '\n');
    const actual = existsSync(stateFile(paths)) ? fileHash(stateFile(paths)) : null;
    if (pending.state.slug !== paths.slug || pending.receipt.hash !== desired || (actual !== pending.previousHash && actual !== desired)) throw new Error('Незавершённая транзакция state конфликтует с внешней правкой');
    atomicJson(stateFile(paths), pending.state); atomicJson(receiptFile(paths), pending.receipt);
    rmSync(pendingFile(paths));
  }
  if (!hasCanonicalState(paths)) {
    if (existsSync(receiptFile(paths))) throw new Error('Канонический state.json удалён; возврат к Markdown запрещён');
    return null;
  }
  assertPlainPath(stateFile(paths)); assertPlainPath(receiptFile(paths));
  const raw = readFileSync(stateFile(paths), 'utf8');
  const state = validateCanonicalState(JSON.parse(raw));
  const receipt = JSON.parse(readFileSync(receiptFile(paths), 'utf8')) as StateReceipt;
  if (state.slug !== paths.slug || receipt.hash !== sha256(raw)) throw new Error('Подмена канонического состояния или чужой slug');
  return { state, receipt };
}

export function writeCanonicalState(paths: WitokPaths, state: CanonicalState, metadata?: Partial<Omit<StateReceipt, 'hash'>>): void {
  validateCanonicalState(state);
  const old = readCanonicalState(paths);
  const receipt = { chunk: 1, attempt: 1, reasons: [], patchSha: null, committedSha: null, gateHash: null, ...old?.receipt, ...metadata, hash: sha256(JSON.stringify(state, null, 2) + '\n') };
  atomicJson(pendingFile(paths), { previousHash: old?.receipt.hash ?? null, state, receipt });
  atomicJson(stateFile(paths), state);
  atomicJson(receiptFile(paths), receipt);
  rmSync(pendingFile(paths));
}

export function initializeCanonicalState(paths: WitokPaths): void {
  if (readCanonicalState(paths)) return;
  writeCanonicalState(paths, { schema_version: 'agent-sdlc/state/v1', slug: paths.slug, stage: 'intent', claims: [], gates: [], attempts: [], decisions: [],
    verification: { passed: false, action: 'retry', review: { schema_version: 'agent-sdlc/verify-review/v1', claims: [], findings: [], scope: [], invariants: [], regressions: [], retry_instruction: '' } } });
}

export function canonicalProblem(paths: WitokPaths): string | null {
  try { readCanonicalState(paths); return null; } catch (error) { return `state-first: ${String(error)}`; }
}

export function synchronizeStateClaims(paths: WitokPaths, intent: string, stage: StageId): void {
  const current = readCanonicalState(paths);
  if (!current) return;
  const claims: CanonicalState['claims'] = [];
  const manual = new Set(manualClaimIds(intent));
  for (const table of parseTables(intent)) for (const row of table.rows) {
    const match = /\bclaim-[1-9][0-9]*\b/.exec(row[0] ?? '');
    if (match && row.length >= 3) {
      if (claims.some(c => c.id === match[0])) throw new Error(`Дублируется требование ${match[0]}`);
      claims.push({ id: match[0], text: row[1]!.trim(), verification: row[2]!.trim(), ...(manual.has(match[0]) ? { tags: ['manual'] } : {}) });
    }
  }
  const state = current.state;
  state.stage = stage;
  state.claims = claims;
  state.verification = { passed: false, action: 'retry', review: { ...state.verification.review, claims: claims.map(c => ({ id: c.id, status: 'uncertain', evidence: [], remediation: 'Требуется свежая проверка' })), findings: [], scope: [], invariants: [], regressions: [] } };
  writeCanonicalState(paths, state);
}

export function recordCanonicalDecision(paths: WitokPaths, decision: CanonicalState['decisions'][number]): void {
  const current = readCanonicalState(paths);
  if (current) { current.state.decisions.push(decision); writeCanonicalState(paths, current.state); }
}

export function openCanonicalAttempt(paths: WitokPaths, chunk: number, attempt: number, stage: 'chunk' | 'verify' = 'chunk'): void {
  const current = readCanonicalState(paths);
  if (!current) return;
  current.state.stage = stage;
  current.state.verification.passed = false; current.state.verification.action = 'retry'; current.state.gates = [];
  const old = current.state.attempts.find(a => a.chunk === chunk && a.number === attempt);
  if (old) old.status = 'open'; else current.state.attempts.push({ chunk, number: attempt, status: 'open' });
  writeCanonicalState(paths, current.state, { chunk, attempt, reasons: ['Проверка текущей попытки ещё не завершена'], committedSha: null });
}

export function recordLegacyImport(paths: WitokPaths, files: string[]): void {
  const current = readCanonicalState(paths);
  if (!current) throw new Error('Нет state для импорта');
  const directory = join(paths.dir, 'state-evidence', 'legacy-import');
  assertPlainPath(directory); mkdirSync(directory, { recursive: true });
  const artifacts: string[] = [];
  for (const file of files.filter(f => existsSync(f))) {
    assertPlainPath(file);
    const name = relative(paths.dir, file);
    if (name.startsWith('..')) throw new Error('Импортируемый артефакт вне витка');
    const target = join(directory, name.replace(/[\\/]/g, '_'));
    writeFileSync(target, readFileSync(file), { flag: 'wx' });
    artifacts.push(`${relative(paths.dir, target).replace(/\\/g, '/')}:${fileHash(target)}`);
  }
  current.state.migration = { source: 'legacy_markdown', artifacts, unresolved: ['legacy_verdict_not_trusted'] };
  writeCanonicalState(paths, current.state);
}

export function stateEvidence(paths: WitokPaths, file: string) {
  const rel = relative(paths.dir, file).replace(/\\/g, '/');
  if (rel.startsWith('..')) throw new Error('Свидетельство не принадлежит витку');
  return { path: `artifact:${rel}`, sha256: fileHash(file) };
}

export function checkStateEvidence(paths: WitokPaths, state: CanonicalState): void {
  for (const g of state.gates) for (const e of g.evidence ?? []) {
    const base = e.path.startsWith('artifact:') ? paths.dir : paths.projectRoot;
    const file = evidenceFile(base, e.path.replace(/^artifact:/, ''));
    if (fileHash(file) !== e.sha256) throw new Error(`Изменено свидетельство: ${e.path}`);
  }
  for (const a of state.attempts) for (const e of [a.diff, a.tests]) if (e) {
    if (fileHash(evidenceFile(paths.dir, e.path.replace(/^artifact:/, ''))) !== e.sha256) throw new Error(`Изменено свидетельство попытки: ${e.path}`);
  }
  for (const field of ['claims', 'findings', 'scope', 'invariants', 'regressions'] as const) {
    for (const record of state.verification.review[field]) for (const ref of record.evidence) {
      evidenceFile(ref.path.startsWith('artifact:') ? paths.dir : paths.projectRoot, ref.path.replace(/^artifact:/, ''));
    }
  }
  for (const artifact of state.migration?.artifacts ?? []) {
    const colon = artifact.lastIndexOf(':');
    if (colon < 1 || fileHash(evidenceFile(paths.dir, artifact.slice(0, colon))) !== artifact.slice(colon + 1)) throw new Error('Импортированные артефакты изменены');
  }
}

export function saveCanonicalVerification(paths: WitokPaths, o: { chunk: number; attempt: number; verdict: Verdict; gates: GateRunResult[]; review: ReviewV1 | null }): void {
  const current = readCanonicalState(paths);
  if (!current) return;
  const state = current.state;
  const log = join(paths.dir, 'state-evidence', `gates-${o.chunk}-${o.attempt}.json`);
  atomicJson(log, o.gates);
  state.stage = 'verify';
  state.gates = o.gates.map(g => ({ name: g.name, stage: 6, enabled: true, status: g.status === '✅' ? 'passed' : g.status === '❌' ? 'failed' : 'skipped', result: g.lastLine, evidence: [stateEvidence(paths, log)] }));
  const review = o.review ?? { ...state.verification.review, claims: state.claims.map(c => ({ id: c.id, status: 'uncertain' as const, evidence: [], remediation: 'Ревью не завершено' })) };
  state.verification = { passed: o.verdict.passed, action: o.verdict.action, review, retry_instruction: o.verdict.reasons.join('\n') };
  if (state.migration && o.verdict.passed && o.review) state.migration.unresolved = [];
  const attempt = { chunk: o.chunk, number: o.attempt, status: o.verdict.passed ? 'passed' as const : o.verdict.action === 'blocked_env' ? 'blocked_env' as const : 'failed' as const,
    ...(existsSync(paths.chunkDiff(o.chunk, o.attempt)) ? { diff: stateEvidence(paths, paths.chunkDiff(o.chunk, o.attempt)) } : {}),
    ...(existsSync(paths.chunkTests(o.chunk, o.attempt)) ? { tests: stateEvidence(paths, paths.chunkTests(o.chunk, o.attempt)) } : {}) };
  state.attempts = state.attempts.filter(a => a.chunk !== o.chunk || a.number !== o.attempt).concat(attempt);
  writeCanonicalState(paths, state, { chunk: o.chunk, attempt: o.attempt, reasons: o.verdict.reasons, gateHash: fileHash(paths.gates), patchSha: existsSync(paths.chunkDiff(o.chunk, o.attempt)) ? fileHash(paths.chunkDiff(o.chunk, o.attempt)) : null });
}
