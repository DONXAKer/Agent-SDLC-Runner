/**
 * Предсортировка двух приёмочных листов (Phase 2 `sdlc-explore`): авторский из задачи и
 * выведенный вслепую. Скилл сам велит «предсортируй механически»: совпало → в таблицу,
 * кандидат в пропуск → человеку, вне scope → назвать строку «Чего не делаем». Здесь ровно
 * это — похожесть строк, а не суждение: решение о полноте остаётся полем человека.
 *
 * Похожесть — по значимым словам (`significantTokens`, та же мера, что у среза патча) с
 * терпимостью к окончаниям: слова сравниваются по первым пяти буквам, потому что «доставка
 * бесплатна» и «считает доставку бесплатной» — одно утверждение.
 */

import { replaceAfterLabel } from '../artifacts/artifact.ts';
import { escapeCell } from '../md/table.ts';
import type { BlindClaim } from '../run/claimsBlind.ts';
import { significantTokens } from '../run/claimEvidence.ts';
import { removeTableInSection, replaceTableRows, spliceFieldValue } from './fields.ts';

export type ClaimVerdict = { kind: 'author'; id: string } | { kind: 'candidate' } | { kind: 'outOfScope'; line: string };

export interface ComparedClaim {
  claim: BlindClaim;
  verdict: ClaimVerdict;
  score: number;
}

export interface AuthorClaim {
  id: string;
  text: string;
}

const STEM = 5;
const MATCH_SCORE = 0.5;
const MATCH_COMMON = 3;
const REVERSE_SCORE = 0.34;

function stems(text: string): Set<string> {
  return new Set(significantTokens(text).map((t) => t.slice(0, STEM)));
}

/** Доля значимых слов `a`, нашедшихся в `b` (по основам), и число общих. */
export function similarity(a: string, b: string): { score: number; common: number } {
  const sa = stems(a);
  const sb = stems(b);
  if (sa.size === 0) return { score: 0, common: 0 };
  let common = 0;
  for (const s of sa) if (sb.has(s)) common++;
  return { score: common / sa.size, common };
}

function bestMatch<T extends { text: string }>(needle: string, hay: readonly T[]): { item: T; score: number; common: number } | null {
  let best: { item: T; score: number; common: number } | null = null;
  for (const item of hay) {
    const s = similarity(needle, item.text);
    if (best === null || s.score > best.score || (s.score === best.score && s.common > best.common)) best = { item, ...s };
  }
  return best;
}

export function compareClaims(derived: readonly BlindClaim[], author: readonly AuthorClaim[], notDoing: readonly string[]): ComparedClaim[] {
  const scope = notDoing.map((line) => ({ text: line }));
  return derived.map((claim) => {
    const full = `${claim.text} ${claim.check}`;
    const a = bestMatch(full, author);
    if (a !== null && (a.score >= MATCH_SCORE || a.common >= MATCH_COMMON)) {
      return { claim, verdict: { kind: 'author', id: a.item.id }, score: a.score };
    }
    const s = bestMatch(claim.text, scope);
    if (s !== null && (s.score >= MATCH_SCORE || s.common >= MATCH_COMMON)) {
      return { claim, verdict: { kind: 'outOfScope', line: s.item.text }, score: s.score };
    }
    return { claim, verdict: { kind: 'candidate' }, score: a?.score ?? 0 };
  });
}

/** Обратное расхождение: у автора есть, у слепого агента нет. */
export function reverseGaps(author: readonly AuthorClaim[], derived: readonly BlindClaim[]): AuthorClaim[] {
  const hay = derived.map((d) => ({ text: `${d.text} ${d.check}` }));
  return author.filter((a) => {
    const m = bestMatch(a.text, hay);
    return m === null || m.score < REVERSE_SCORE;
  });
}

const SECTION = /выведенн\S*\s+независимо/i;
const TEMPLATE = 'exploration-report.template.md';

function verdictCell(v: ClaimVerdict): string {
  switch (v.kind) {
    case 'author':
      return `да (${v.id})`;
    case 'candidate':
      return '**нет — кандидат в пропуск**';
    case 'outOfScope':
      return `вне scope — противоречит «${v.line.replace(/^[-*]\s*/, '')}»`;
  }
}

/** Таблица сверки и строка «Расхождение» — построчно, как `renderAxes.ts`; решение человека не трогается. */
export function renderClaimsComparison(reportText: string, compared: readonly ComparedClaim[], gaps: readonly AuthorClaim[]): string {
  const rows = compared.map((c, i) => {
    const tags = c.claim.tags.map((t) => ` [${t}]`).join('');
    return `| ${i + 1} | ${escapeCell(`${c.claim.text}${tags} — ${c.claim.check}`)} | ${escapeCell(verdictCell(c.verdict))} |`;
  });
  let text = replaceTableRows(reportText, SECTION, rows);
  const candidates = compared.filter((c) => c.verdict.kind === 'candidate').length;
  const outOfScope = compared.filter((c) => c.verdict.kind === 'outOfScope').length;
  const parts: string[] = [];
  if (candidates > 0) parts.push(`у агента есть, у автора нет: ${candidates} (кандидаты в пропуск в таблице)`);
  if (outOfScope > 0) parts.push(`вне scope: ${outOfScope}`);
  if (gaps.length > 0) parts.push(`у автора есть, у агента нет: ${gaps.map((g) => g.id).join(', ')}`);
  const value = parts.length === 0 ? 'списки совпали' : parts.join('; ');
  return writeRazhozhdenie(text, value);
}

/** Второго измерения не было: таблица заменяется строкой `н/п — причина`, «Расхождение» — тоже. */
export function renderClaimsNa(reportText: string, reason: string): string {
  const text = removeTableInSection(reportText, SECTION, `н/п — ${reason}`);
  return writeRazhozhdenie(text, 'н/п — второго измерения не было');
}

/**
 * Поле «Расхождение» — плейсхолдер `spliceFieldValue`, повторный проход по уже заполненной
 * строке (после первого прохода значение — голый текст без `/`-альтернатив и без `‹…›`,
 * схема больше не видит строку полем) — `replaceAfterLabel` по самой метке. Тот же приём
 * и та же причина, что у «Гейта «Заполненность артефактов»» в `ExploreExecutor.ts`: без
 * отката таблица сверки НАД этой строкой (`replaceTableRows`, независим от схемы) обновится
 * на втором проходе, а сводная фраза «Расхождение» под ней молча останется от первого —
 * отчёт разойдётся сам с собой (ревью code-review-all, 2026-09-11).
 */
function writeRazhozhdenie(text: string, value: string): string {
  return spliceFieldValue(text, TEMPLATE, 'расхождение', value) ?? replaceAfterLabel(text, 'Расхождение', value) ?? text;
}
