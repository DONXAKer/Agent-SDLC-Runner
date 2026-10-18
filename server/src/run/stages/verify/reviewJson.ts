/**
 * `.chunk-N-attempt-K-review.json` — ответ рецензента по контракту `verify-review-v1`.
 *
 * Источник — ответ, принятый `acceptReviewText` (свободный ход рецензента, `Task`). Когда
 * ревью шло конвейером (`reviewFill`/`claimFill`) или записями модели, JSON собирается из
 * тех же записей отчёта: статусы пунктов и находки в нём — те, что пошли в вердикт, а
 * ссылка `файл:символ` записи раскладывается в `path`/`anchor` по первому двоеточию.
 * Записей нет — файла нет: пустой JSON читался бы как «ревью прошло без находок».
 */

import { writeFileSync } from 'node:fs';

import type { ClaimStatus, FindingSection } from '@sdlc-runner/shared';

import type { StageHost } from '../types.ts';
import { REVIEW_SCHEMA_VERSION } from './reviewValidate.ts';
import type { ReviewFinding, ReviewRef, ReviewStatus, ReviewV1 } from './reviewValidate.ts';

const WORD: Record<ClaimStatus, ReviewStatus> = { '✅': 'passed', '❌': 'failed', '⚠': 'uncertain', manual: 'manual' };

function refsOf(evidence: string): ReviewRef[] {
  const clean = evidence.replace(/_\(ссылка не найдена в патче попытки\)_/g, '').trim();
  if (clean === '') return [];
  return clean.split(/;\s*/).filter((s) => s !== '').map((s) => {
    const at = s.indexOf(':');
    return at > 0 ? { path: s.slice(0, at).trim(), anchor: s.slice(at + 1).trim() || s } : { path: s.trim(), anchor: s.trim() };
  });
}

export function reviewFromRecords(host: StageHost): ReviewV1 | null {
  const verify = host.verifyState;
  if (verify.reviewJson !== null) return verify.reviewJson;
  if (verify.claimRecords.size === 0 && verify.findingRecords.length === 0) return null;
  const lists: Record<FindingSection, ReviewFinding[]> = { review: [], scope: [], invariant: [], regression: [] };
  const kindOf: Record<FindingSection, ReviewFinding['kind']> = { review: 'mismatch', scope: 'scope', invariant: 'invariant', regression: 'regression' };
  for (const f of verify.findingRecords) lists[f.section].push({ kind: kindOf[f.section], summary: f.text, evidence: refsOf(f.evidence) });
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    claims: [...verify.claimRecords.values()].map((c) => ({
      id: c.id.toLowerCase(),
      status: WORD[c.status],
      evidence: refsOf(c.evidence),
      remediation: c.whatToFix ?? '',
    })),
    findings: lists.review,
    scope: lists.scope,
    invariants: lists.invariant,
    regressions: lists.regression,
    retry_instruction: [...verify.claimRecords.values()].map((c) => c.whatToFix).find((w) => w !== null && w !== '') ?? '',
  };
}

export function writeReviewJson(host: StageHost): boolean {
  const review = reviewFromRecords(host);
  if (review === null) return false;
  writeFileSync(host.paths.chunkReview(host.chunk(), host.attempt()), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  // Сырой ответ рецензента как есть — артефакт попытки методологии (`chunk-N-attempt-K-review.md`).
  const raw = host.verifyState.reviewText;
  if (raw !== null) writeFileSync(host.paths.chunkReviewText(host.chunk(), host.attempt()), raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
  return true;
}
