/**
 * Ответ рецензента принимается только структурированным и адресным — контракт
 * `verify-review-v1` (`implementations/runner-contract/schemas/verify-review-v1.schema.json`
 * методологии; порт `review-validate.py`). Один контракт на сессию и раннер: рецензент
 * возвращает рядом с markdown fenced-блок ```json.
 *
 * Проверки: JSON-блок разбирается; `claims` — ровно те id, что в задаче; статус из словаря
 * (глифы `✅/❌/⚠` приводятся к словам); у passed/failed — хотя бы одна ссылка evidence
 * (path + anchor); у каждой находки во всех четырёх массивах — kind своего массива и
 * evidence с path из патча попытки (или `intent.md`/`plan.md`/`gates.md` для находок про
 * артефакты); хотя бы одна ссылка ответа называет путь из патча; `retry_instruction` —
 * строка. Любой мусор в структуре — ошибка в списке, не исключение.
 */

import { basename } from 'node:path';

export const REVIEW_SCHEMA_VERSION = 'agent-sdlc/verify-review/v1';
export const REVIEW_STATUSES = ['passed', 'failed', 'uncertain', 'manual'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_KINDS = {
  findings: ['mismatch', 'uncovered_behavior'],
  scope: ['scope'],
  invariants: ['invariant'],
  regressions: ['regression'],
} as const;
export type ReviewFindingField = keyof typeof REVIEW_KINDS;
export type ReviewKind = (typeof REVIEW_KINDS)[ReviewFindingField][number];
const ARTIFACT_PATHS = new Set(['intent.md', 'plan.md', 'gates.md']);
const GLYPH_STATUS: Record<string, ReviewStatus> = { '✅': 'passed', '❌': 'failed', '⚠': 'uncertain' };

export interface ReviewRef {
  path: string;
  anchor: string;
}

export interface ReviewClaim {
  id: string;
  status: ReviewStatus;
  evidence: ReviewRef[];
  remediation: string;
}

export interface ReviewFinding {
  kind: ReviewKind;
  summary: string;
  evidence: ReviewRef[];
}

export interface ReviewV1 {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  claims: ReviewClaim[];
  findings: ReviewFinding[];
  scope: ReviewFinding[];
  invariants: ReviewFinding[];
  regressions: ReviewFinding[];
  retry_instruction: string;
}

export interface ReviewValidation {
  valid: boolean;
  errors: string[];
  /** Нормализованный ответ — только когда ошибок нет. */
  review: ReviewV1 | null;
}

/** JSON из fenced-блока ```json (первого), иначе — весь текст; `null` — не разбирается. */
export function extractReviewJson(text: string): { value: unknown } | { error: string } {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  const raw = m === null ? text.trim() : m[1]!;
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `JSON не разбирается: ${(e as Error).message}` };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refsOf(item: Record<string, unknown>, where: string, paths: ReadonlySet<string>, errors: string[]): { refs: ReviewRef[]; hitPatch: boolean } {
  const refs: ReviewRef[] = [];
  let hitPatch = false;
  const ev = item['evidence'];
  if (ev === undefined || ev === null) return { refs, hitPatch };
  if (!Array.isArray(ev)) {
    errors.push(`${where}: evidence не массив`);
    return { refs, hitPatch };
  }
  for (const ref of ev) {
    if (!isObj(ref) || typeof ref['path'] !== 'string' || ref['path'] === '' || typeof ref['anchor'] !== 'string' || ref['anchor'] === '') {
      errors.push(`${where}: ссылка без path/anchor`);
      continue;
    }
    refs.push({ path: ref['path'], anchor: ref['anchor'] });
    if (paths.has(ref['path'].replace(/\\/g, '/'))) hitPatch = true;
  }
  return { refs, hitPatch };
}

export function validateReview(raw: unknown, intentClaims: ReadonlySet<string>, patchPaths: ReadonlySet<string>): ReviewValidation {
  const errors: string[] = [];
  if (!isObj(raw)) return { valid: false, errors: ['ответ не объект'], review: null };
  const sv = raw['schema_version'];
  if (sv !== undefined && sv !== null && sv !== REVIEW_SCHEMA_VERSION) errors.push(`schema_version «${String(sv)}» ≠ ${REVIEW_SCHEMA_VERSION}`);

  const claims: ReviewClaim[] = [];
  const rawClaims = raw['claims'];
  const ids: (string | null)[] = [];
  let anyPatchRef = false;
  if (!Array.isArray(rawClaims)) {
    errors.push('нет массива claims');
  } else {
    rawClaims.forEach((c, i) => {
      if (!isObj(c)) {
        errors.push(`claims[${i}]: не объект`);
        return;
      }
      const cid = typeof c['id'] === 'string' ? c['id'].toLowerCase() : null;
      let st = c['status'];
      if (typeof st === 'string' && GLYPH_STATUS[st] !== undefined) st = GLYPH_STATUS[st];
      ids.push(cid);
      if (typeof st !== 'string' || !(REVIEW_STATUSES as readonly string[]).includes(st)) {
        errors.push(`${cid ?? `claims[${i}]`}: статус «${String(st)}» вне ${JSON.stringify(REVIEW_STATUSES)}`);
      }
      const { refs, hitPatch } = refsOf(c, cid ?? `claims[${i}]`, patchPaths, errors);
      anyPatchRef = anyPatchRef || hitPatch;
      if ((st === 'passed' || st === 'failed') && refs.length === 0) errors.push(`${cid}: статус ${st} без единой ссылки evidence`);
      if ('remediation' in c && c['remediation'] !== undefined && typeof c['remediation'] !== 'string') errors.push(`${cid}: remediation не строка`);
      claims.push({
        id: cid ?? '',
        status: (typeof st === 'string' && (REVIEW_STATUSES as readonly string[]).includes(st) ? st : 'uncertain') as ReviewStatus,
        evidence: refs,
        remediation: typeof c['remediation'] === 'string' ? c['remediation'] : '',
      });
    });
  }
  const validIds = ids.filter((i): i is string => i !== null);
  const uniq = new Set(validIds);
  const same = uniq.size === intentClaims.size && [...intentClaims].every((c) => uniq.has(c));
  if (!same || uniq.size !== validIds.length || validIds.length !== ids.length) {
    errors.push(`набор id не совпадает с задачей: ответ ${JSON.stringify([...uniq].sort())} ↔ задача ${JSON.stringify([...intentClaims].sort())}`);
  }

  const lists: Record<ReviewFindingField, ReviewFinding[]> = { findings: [], scope: [], invariants: [], regressions: [] };
  for (const field of Object.keys(REVIEW_KINDS) as ReviewFindingField[]) {
    const kinds: readonly string[] = REVIEW_KINDS[field];
    const items = raw[field];
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) {
      errors.push(`${field}: не массив`);
      continue;
    }
    items.forEach((f, i) => {
      const where = `${field}[${i}]`;
      if (!isObj(f)) {
        errors.push(`${where}: находка не объект`);
        return;
      }
      const summary = typeof f['summary'] === 'string' ? f['summary'] : '';
      if (summary.trim() === '') errors.push(`${where}: нет summary`);
      let kind = f['kind'];
      if ((kind === undefined || kind === null) && kinds.length === 1) kind = kinds[0];
      if (typeof kind !== 'string' || !kinds.includes(kind)) errors.push(`${where}: kind «${String(kind)}» вне ${JSON.stringify(kinds)}`);
      const { refs, hitPatch } = refsOf(f, where, patchPaths, errors);
      if (refs.length === 0) errors.push(`${where} «${summary.slice(0, 40)}»: без evidence`);
      for (const r of refs) {
        const p = r.path.replace(/\\/g, '/');
        if (!patchPaths.has(p) && !ARTIFACT_PATHS.has(basename(p))) {
          errors.push(`${where}: ссылается на «${r.path}», которого нет ни в патче, ни среди артефактов`);
        }
      }
      anyPatchRef = anyPatchRef || hitPatch;
      lists[field].push({ kind: (typeof kind === 'string' ? kind : kinds[0]!) as ReviewKind, summary, evidence: refs });
    });
  }
  if (!anyPatchRef && patchPaths.size > 0) errors.push('ни одна ссылка ответа не называет путь из патча — разбор неотличим от пересказа');
  const retry = raw['retry_instruction'];
  if (retry !== undefined && retry !== null && typeof retry !== 'string') errors.push('retry_instruction не строка');

  if (errors.length > 0) return { valid: false, errors, review: null };
  return {
    valid: true,
    errors: [],
    review: {
      schema_version: REVIEW_SCHEMA_VERSION,
      claims,
      findings: lists.findings,
      scope: lists.scope,
      invariants: lists.invariants,
      regressions: lists.regressions,
      retry_instruction: typeof retry === 'string' ? retry : '',
    },
  };
}

/** Текст ответа → контракт: разбор и проверка одним вызовом. */
export function parseReviewText(text: string, intentClaims: ReadonlySet<string>, patchPaths: ReadonlySet<string>): ReviewValidation {
  const parsed = extractReviewJson(text);
  if ('error' in parsed) return { valid: false, errors: [parsed.error], review: null };
  return validateReview(parsed.value, intentClaims, patchPaths);
}
