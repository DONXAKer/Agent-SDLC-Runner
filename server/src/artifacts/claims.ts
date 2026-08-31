/**
 * Подсчёт пунктов приёмочного листа — ОДНО правило на двух потребителей: гейт минимума
 * этапа 1 (`stages.claimsMinimum`) и добор поля-листа в formFill. Раздельные копии
 * regex'а уже расходились (гейт требовал голый `claim-N` и не видел канонический
 * `` `claim-1 [edge]` `` — блокировал разведку на правильном листе).
 */

/** Норма полного контура («полный контур: пунктов ≥ 3, из них ≥ 2 с [edge]»). Мелкий
 * контур мягче (1/0) — это знает только гейт: добору переизбыток пунктов не вредит. */
export const CLAIMS_MINIMUM = { rows: 3, edges: 2 } as const;

const CLAIM_ROW = /^\s*\|\s*`?claim-\d+\b[^|]*\|/;

export function countClaims(text: string): { rows: number; edges: number } {
  const rows = text.split(/\r?\n/).filter((l) => CLAIM_ROW.test(l));
  return { rows: rows.length, edges: rows.filter((l) => /\[edge\]/i.test(l)).length };
}

/** id пункта из строки листа — `claim-3` из `| \`claim-3 [edge]\` | … |`, иначе null. */
export function claimIdOf(line: string): string | null {
  const m = /^\s*\|\s*`?(claim-\d+)\b/.exec(line);
  return m === null ? null : m[1]!;
}
