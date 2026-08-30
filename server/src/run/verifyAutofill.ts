/**
 * Автозаполнение отчёта приёмки фактами рантайма — ДО модели-рецензента.
 *
 * Два класса фактов, оба не знания модели:
 *  - механические поля шапки (номер chunk'а, попытка, слаг, бюджет попыток) — тот же
 *    принцип, что у `journalAutofill.ts`;
 *  - таблица «Гейты»: статусы и результаты фактического прогона `runVerifyGates`.
 *    Замер серии r9 (`docs/model-runs.md`): дешёвый рецензент-«оформитель» (gpt-oss-20b)
 *    дал 4 расхождения отчёта с фактом — все в переписанной от себя таблице гейтов.
 *    Таблицу, которую рантайм прогнал сам, он и заполняет сам: расхождений «отчёт/факт»
 *    в ней не бывает по построению, модели остаются выводы и ревью.
 *
 * Строка «Ревью независимым агентом» НЕ заполняется: на момент автозаполнения рецензент
 * ещё не запускался, и вписать туда пред-стартовый статус значило бы солгать в обе стороны.
 */

import type { GateRunResult } from '@sdlc-runner/shared';

import { placeholderRanges } from '../artifacts/artifact.ts';
import { gateKey } from '../gates/gatesFile.ts';

export interface VerifyReportFacts {
  chunk: number;
  attempt: number;
  slug: string;
  attemptBudget: number;
}

/** Однострочная ячейка таблицы: переносы и вертикальные черты в ней жить не могут. */
function cellSafe(text: string, max = 240): string {
  const one = text.replace(/\s*\r?\n\s*/g, '; ').replace(/\|/g, '∣').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function resultCell(r: GateRunResult): string {
  const parts = [
    r.command ?? 'встроенная реализация',
    ...(r.exitCode === null ? [] : [`код ${r.exitCode}`]),
    ...(r.durationMs > 0 ? [`${(r.durationMs / 1000).toFixed(1)}с`] : []),
    r.lastLine,
  ];
  return cellSafe(parts.join(' · '));
}

/** Первая ячейка markdown-строки таблицы. `null` — строка не табличная. */
function firstCell(line: string): string | null {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line.split('|');
  return cells.length < 3 ? null : (cells[1]?.trim() ?? null);
}

/**
 * Заполняет отчёт приёмки: механические плейсхолдеры шапки и строки таблицы «Гейты» по
 * фактам прогона. Идемпотентно — заполненное плейсхолдером быть перестаёт. Гейты, которым
 * рантайм статуса не давал (ревью, чужие имена), не трогаются.
 */
export function autofillVerificationReport(
  text: string,
  gates: readonly GateRunResult[],
  f: VerifyReportFacts,
): { text: string; filled: number } {
  let filled = 0;

  // Шаг 1: таблица «Гейты» — построчно, только в своей секции и только строки с
  // незаполненным статусом: строку, уже написанную кем-то, рантайм не переписывает.
  const byKey = new Map(gates.map((g) => [gateKey(g.name), g]));
  const used = new Set<string>();
  const lines = text.split('\n');
  const gatesStart = lines.findIndex((l) => /^##\s+Гейты\s*$/.test(l));
  const gatesEnd = lines.findIndex((l, i) => i > gatesStart && /^#{2,3}\s/.test(l));
  if (gatesStart >= 0) {
    const stop = gatesEnd < 0 ? lines.length : gatesEnd;
    for (let i = gatesStart + 1; i < stop; i++) {
      const line = lines[i]!;
      const name = firstCell(line);
      if (name === null || !line.includes('‹')) continue;
      const r = byKey.get(gateKey(name));
      if (r === undefined) continue;
      lines[i] = `| ${name} | ${r.status} | ${resultCell(r)} |`;
      used.add(gateKey(name));
      filled++;
    }
    // Строка-образец «прочий включённый гейт» разворачивается в фактические строки
    // оставшихся прогнанных гейтов — либо убирается: образец не отчёт.
    const otherIdx = lines.findIndex(
      (l, i) => i > gatesStart && i < stop && l.includes('‹прочий включённый гейт'),
    );
    if (otherIdx >= 0) {
      const rest = gates.filter((g) => !used.has(gateKey(g.name)));
      lines.splice(otherIdx, 1, ...rest.map((r) => `| ${r.name} | ${r.status} | ${resultCell(r)} |`));
      filled += rest.length > 0 ? rest.length : 1;
    }
  }
  let out = lines.join('\n');

  // Шаг 2: механические плейсхолдеры шапки и вердикта — с конца, чтобы сплайс не сдвигал
  // необработанные диапазоны. Решения человека («Утвердил») не подделываются.
  for (const range of [...placeholderRanges(out)].reverse()) {
    const inner = range.text.slice(1, -1);
    const lineStart = out.lastIndexOf('\n', range.start - 1) + 1;
    const lineEnd = out.indexOf('\n', range.start);
    const line = out.slice(lineStart, lineEnd < 0 ? out.length : lineEnd);
    if (/Утвердил/i.test(line)) continue;

    const value =
      inner === 'N'
        ? String(f.chunk)
        : inner === 'K'
          ? String(f.attempt)
          : inner === 'название витка'
            ? f.slug
            : inner === 'бюджет'
              ? String(f.attemptBudget)
              : null;
    if (value === null) continue;
    out = out.slice(0, range.start) + value + out.slice(range.end);
    filled++;
  }

  return { text: out, filled };
}
