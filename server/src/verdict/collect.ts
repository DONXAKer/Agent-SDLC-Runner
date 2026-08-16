/**
 * Сборка входа вердикта: набор гейтов + прогон рантайма + отчёт приёмки → `VerdictInput`.
 *
 * Здесь и только здесь встречаются два источника статуса. Гейты, которые рантайм прогнал
 * сам, берутся из прогона: файлы исполнителя — свидетельство этапа 5, а не источник
 * вердикта, и переписанный рецензентом статус не должен подменять фактический код
 * возврата. Остальное — из отчёта, потому что больше неоткуда.
 *
 * Расхождение между двумя источниками не сглаживается: если рецензент написал `✅` там,
 * где прогон дал `❌`, побеждает прогон, а расхождение попадает в причины.
 */

import type { ClaimStatus, GateRunResult, GateStatus, VerdictInput } from '@sdlc-runner/shared';

import { columnIndex, parseTables } from '../md/table.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { gatesExpectedInReport, openDebt } from '../gates/gatesFile.ts';

const PLACEHOLDER = /[‹<][^›>]*[›>]/;
const HAS_NAME = /\p{L}{2,}/u;

function normName(s: string): string {
  return s.replace(/`/g, '').trim().toLowerCase().replace(/ё/g, 'е');
}

function parseGateStatus(cell: string): GateStatus | null {
  if (PLACEHOLDER.test(cell)) return null;
  if (cell.includes('❌')) return '❌';
  if (cell.includes('⏭')) return '⏭';
  if (cell.includes('✅')) return '✅';
  return null;
}

function parseClaimStatus(cell: string): ClaimStatus | null {
  if (PLACEHOLDER.test(cell)) return null;
  if (cell.includes('❌')) return '❌';
  if (cell.includes('⚠')) return '⚠';
  if (cell.includes('✅')) return '✅';
  return null;
}

/** Значение пункта списка вида «- Метка: значение». `null`, если пункта нет. */
function bullet(report: string, label: RegExp): string | null {
  for (const line of report.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('-') && !t.startsWith('*')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    if (!label.test(body)) continue;
    const i = body.indexOf(':');
    return i < 0 ? '' : body.slice(i + 1).replace(/\*\*/g, '').trim();
  }
  return null;
}

/** «н/п», «нет», «—» и плейсхолдер — это «пусто», а не содержимое. */
function isEmptyValue(v: string | null): boolean {
  if (v === null) return true;
  const t = v.trim().toLowerCase().replace(/ё/g, 'е');
  if (t === '') return true;
  if (PLACEHOLDER.test(v)) return true;
  // Без `\b`: в JS она считается по ASCII, и после кириллического «нет» её нет —
  // «нет» читалось бы как содержательная находка и роняло бы каждый зелёный виток.
  return /^(н\/п|нет|—|-|отсутствуют?|не выявлено|нету)(\s|[.,;—–-]|$)/.test(t);
}

export interface ReportFacts {
  gateStatuses: Map<string, GateStatus>;
  inapplicable: Map<string, string>;
  claims: { id: string; status: ClaimStatus }[];
  confirmedReviewFindings: number;
  brokenInvariants: string[];
  regressions: string[];
  plannedPathsUntouched: string[];
  diffMatchesTree: boolean;
}

export function readReport(report: string): ReportFacts {
  const tables = parseTables(report);

  const gateStatuses = new Map<string, GateStatus>();
  const inapplicable = new Map<string, string>();
  const claims: { id: string; status: ClaimStatus }[] = [];

  for (const t of tables) {
    const gateCol = columnIndex(t.header, 'гейт');
    const statusCol = columnIndex(t.header, 'статус');
    const signedCol = columnIndex(t.header, 'утвердил');
    const idCol = columnIndex(t.header, 'id');

    // Таблица неприменимости: имя гейта + кто подписал. Колонки «Статус» у неё нет,
    // и это единственный надёжный признак — заголовок секции у неё общий с гейтами.
    if (gateCol >= 0 && signedCol >= 0) {
      for (const row of t.rows) {
        const name = row[gateCol] ?? '';
        const who = row[signedCol] ?? '';
        if (name === '' || PLACEHOLDER.test(name)) continue;
        // Колонка «Утвердил» без имени = артефакт не заполнен, а не «подписано».
        if (!HAS_NAME.test(who) || PLACEHOLDER.test(who)) continue;
        inapplicable.set(normName(name), who.trim());
      }
      continue;
    }

    if (gateCol >= 0 && statusCol >= 0) {
      for (const row of t.rows) {
        const name = row[gateCol] ?? '';
        if (name === '' || PLACEHOLDER.test(name)) continue;
        const st = parseGateStatus(row[statusCol] ?? '');
        // Строка есть, а статуса в ней нет — это не «прошёл». Гейт со стёртым статусом
        // получает `⏭` и роняет вердикт, как и не запускавшийся.
        gateStatuses.set(normName(name), st ?? '⏭');
      }
      continue;
    }

    if (idCol >= 0) {
      const passedCol = columnIndex(t.header, 'passed');
      for (const row of t.rows) {
        const id = (row[idCol] ?? '').replace(/`/g, '').trim();
        if (id === '' || PLACEHOLDER.test(id)) continue;
        const st = passedCol >= 0 ? parseClaimStatus(row[passedCol] ?? '') : null;
        // Пункт без статуса — доказательства нет. Это `⚠`, а не пропуск строки.
        claims.push({ id, status: st ?? '⚠' });
      }
    }
  }

  const listAfter = (heading: RegExp, label: RegExp): string[] => {
    const v = bullet(sectionText(report, heading), label);
    return isEmptyValue(v) ? [] : [v!.trim()];
  };

  const reviewFindings = listAfter(/^2\./, /Подтверждённое расхождение/i);

  const invariants: string[] = [];
  for (const line of sectionText(report, /^4\./).split(/\r?\n/)) {
    const m = /нарушен:\s*(.+)$/i.exec(line);
    if (m !== null && !PLACEHOLDER.test(m[1]!)) invariants.push(m[1]!.trim());
  }

  const regressions: string[] = [];
  for (const line of sectionText(report, /^5\./).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('-') && !t.startsWith('*')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    if (isEmptyValue(body)) continue;
    if (/^_/.test(body)) continue; // курсивная подсказка формы
    regressions.push(body);
  }

  // «не сделано» — красный вердикт. «не потребовалось, потому что X» — правка плана,
  // и сюда не попадает: различие несёт формулировка, и молчание не годится ни в одну
  // из сторон.
  const untouched: string[] = [];
  for (const line of sectionText(report, /^3\./).split(/\r?\n/)) {
    if (!/«?не сделано»?/i.test(line)) continue;
    if (PLACEHOLDER.test(line)) continue;
    const path = /^[\s-*]*[`«]?([^`»—-]+)/.exec(line.trim())?.[1]?.trim() ?? line.trim();
    untouched.push(path);
  }

  const sync = bullet(report, /Сверка с деревом/i);
  // Утверждение «совпал» должно быть сказано. Отсутствие строки — не «да».
  const diffMatchesTree =
    sync !== null &&
    !PLACEHOLDER.test(sync) &&
    /(^|[\s:*(])да([\s.,;)]|$)/i.test(sync) &&
    !/(^|[\s:*(])нет([\s.,;)—–-]|$)/i.test(sync);

  return {
    gateStatuses,
    inapplicable,
    claims,
    confirmedReviewFindings: reviewFindings.length,
    brokenInvariants: invariants,
    regressions,
    plannedPathsUntouched: untouched,
    diffMatchesTree,
  };
}

/** Текст секции от её заголовка до следующего заголовка того же или высшего уровня. */
function sectionText(report: string, title: RegExp): string {
  const lines = report.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  let level = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h !== null) {
      const l = h[1]!.length;
      if (inside && l <= level) break;
      if (!inside && title.test(h[2]!.trim())) {
        inside = true;
        level = l;
        continue;
      }
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

export interface CollectInput {
  gates: GatesFile;
  /** Что рантайм прогнал сам на этом этапе. */
  gateResults: readonly GateRunResult[];
  /** Текст `verification-report-<N>-attempt-<K>.md`. Пусто — отчёта нет. */
  report: string;
  attempt: number;
  attemptBudget: number;
  noProgress: boolean;
}

export interface CollectResult {
  input: VerdictInput;
  /** Гейты, где отчёт и прогон разошлись. Побеждает прогон, расхождение — в причины. */
  disagreements: string[];
}

export function collectVerdictInput(i: CollectInput): CollectResult {
  const facts = readReport(i.report);
  const expected = gatesExpectedInReport(i.gates);
  const byRun = new Map(i.gateResults.map((r) => [normName(r.name), r]));

  const gates: VerdictInput['gates'] = [];
  const missing: string[] = [];
  const disagreements: string[] = [];

  for (const row of expected) {
    const key = normName(row.name);
    const run = byRun.get(key);
    const reported = facts.gateStatuses.get(key);

    if (reported === undefined) {
      missing.push(row.name);
      // Строки в отчёте нет — но и молча пропустить гейт нельзя: если рантайм его
      // прогнал, статус известен и обязан участвовать в вердикте.
      if (run !== undefined) {
        gates.push({
          name: row.name,
          status: run.status,
          inapplicableSignedBy: facts.inapplicable.get(key) ?? null,
        });
      }
      continue;
    }

    const status = run?.status ?? reported;
    if (run !== undefined && run.status !== reported) {
      disagreements.push(
        `гейт «${row.name}»: в отчёте ${reported}, фактический прогон дал ${run.status} — ` +
          `вердикт считается по прогону`,
      );
    }
    gates.push({
      name: row.name,
      status,
      inapplicableSignedBy: facts.inapplicable.get(key) ?? null,
    });
  }

  return {
    disagreements,
    input: {
      gates,
      claims: facts.claims,
      confirmedReviewFindings: facts.confirmedReviewFindings,
      enabledGatesMissingFromReport: missing,
      openDebtRows: openDebt(i.gates),
      brokenInvariants: facts.brokenInvariants,
      regressions: facts.regressions,
      plannedPathsUntouched: facts.plannedPathsUntouched,
      diffMatchesTree: facts.diffMatchesTree,
      attempt: i.attempt,
      attemptBudget: i.attemptBudget,
      noProgress: i.noProgress,
    },
  };
}
