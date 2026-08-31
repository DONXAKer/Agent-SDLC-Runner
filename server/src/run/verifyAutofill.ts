/**
 * Автозаполнение отчёта приёмки фактами рантайма — ДО модели-рецензента.
 *
 * Два класса фактов, оба не знания модели:
 *  - механические поля шапки (номер chunk'а, попытка, слаг, бюджет попыток) — общей
 *    механикой `fillMechanicalPlaceholders` (см. journalAutofill.ts);
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

import { gateKey } from '../gates/gatesFile.ts';
import { escapeCell, splitRow } from '../md/table.ts';
import { fillMechanicalPlaceholders } from './journalAutofill.ts';

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

/** Первая ячейка markdown-строки таблицы — через общий `splitRow` (знает про `\|`). */
function firstCell(line: string): string | null {
  if (!line.trimStart().startsWith('|')) return null;
  return splitRow(line)[0] ?? null;
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

  // Шаг 1: ПЕРВАЯ таблица после «## Гейты» — и только она. Граница «до следующего
  // заголовка» накрывала и таблицу неприменимости (между ними заголовка нет), и строка
  // неприменимости с настоящим именем гейта переписывалась в строку статуса — колонка
  // «Утвердил (человек)» уничтожалась рантаймом (ревью, К3/К5). Первая таблица кончается
  // на первой не-табличной строке, дальше не смотрим. Принятый риск (ревью-2): граница
  // держится на пустой строке/прозе штатного шаблона между таблицами; автозаполнение
  // идёт ДО модели по бланку рантайма, где это гарантировано, — слипшиеся таблицы из-под
  // пера модели сюда не попадают.
  const byKey = new Map(gates.map((g) => [gateKey(g.name), g]));
  const used = new Set<string>();
  const lines = text.split('\n');
  const gatesStart = lines.findIndex((l) => /^##\s+Гейты\s*$/.test(l));
  if (gatesStart >= 0) {
    let i = gatesStart + 1;
    while (i < lines.length && !lines[i]!.trimStart().startsWith('|')) {
      if (/^#{2,3}\s/.test(lines[i]!)) break; // секция без таблицы — заполнять нечего
      i++;
    }
    const tableStart = i;
    let tableEnd = tableStart;
    while (tableEnd < lines.length && lines[tableEnd]!.trimStart().startsWith('|')) tableEnd++;

    for (let j = tableStart; j < tableEnd; j++) {
      const line = lines[j]!;
      const name = firstCell(line);
      if (name === null || !line.includes('‹')) continue;
      const r = byKey.get(gateKey(name));
      if (r === undefined) continue;
      // Черта в имени экранируется обратно: splitRow её разэкранировал, и пересборка без
      // `\|` ломала бы колонки строки (ревью-2; имён с чертой в эталоне нет — страховка).
      lines[j] = `| ${escapeCell(name)} | ${r.status} | ${resultCell(r)} |`;
      used.add(gateKey(name));
      filled++;
    }
    // Строка-образец «прочий включённый гейт» разворачивается в фактические строки
    // оставшихся прогнанных гейтов — либо убирается: образец не отчёт.
    const otherIdx = lines.findIndex(
      (l, k) => k >= tableStart && k < tableEnd && l.includes('‹прочий включённый гейт'),
    );
    if (otherIdx >= 0) {
      const rest = gates.filter((g) => !used.has(gateKey(g.name)));
      lines.splice(
        otherIdx,
        1,
        // Черта в имени экранируется и здесь — та же страховка, что у именованных строк.
        ...rest.map((r) => `| ${escapeCell(r.name)} | ${r.status} | ${resultCell(r)} |`),
      );
      filled += rest.length > 0 ? rest.length : 1;
    }
  }

  // Шаг 2: механические плейсхолдеры шапки и вердикта — общей механикой (та же, что у
  // журнала chunk'а: с конца, строки решений человека не трогаются).
  const mech = fillMechanicalPlaceholders(lines.join('\n'), (inner) =>
    inner === 'N'
      ? String(f.chunk)
      : inner === 'K'
        ? String(f.attempt)
        : inner === 'название витка'
          ? f.slug
          : inner === 'бюджет'
            ? String(f.attemptBudget)
            : null,
  );

  return { text: mech.text, filled: filled + mech.filled };
}
