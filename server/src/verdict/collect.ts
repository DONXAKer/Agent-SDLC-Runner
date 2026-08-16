/**
 * Сборка входа вердикта: набор гейтов + прогон рантайма + отчёт приёмки → `VerdictInput`.
 *
 * Здесь и только здесь встречаются два источника статуса: фактический прогон рантайма и
 * отчёт, который пишет модель. Расхождение между ними не сглаживается — в вердикт идёт
 * ХУДШИЙ из двух статусов, а само расхождение попадает в причины.
 *
 * Почему именно худший, а не «прогон всегда прав»: правило «побеждает прогон» защищало
 * от рецензента, перекрашивающего красное в зелёное, но работало и в обратную сторону —
 * рецензент ставил `❌`, найдя расхождение, а фиктивный «прогон» перебивал его зелёным.
 * Оба источника могут ошибаться в сторону зелёного и ни один — в сторону красного, и
 * только поэтому максимум по строгости безопасен.
 */

import type { ClaimStatus, GateRunResult, GateStatus, VerdictInput } from '@sdlc-runner/shared';

import { hasPlaceholder, isSignedByHuman } from '../artifacts/artifact.ts';
import { columnIndex, parseTables } from '../md/table.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { gateKey, gatesExpectedInReport, openDebt } from '../gates/gatesFile.ts';

const PLACEHOLDER = { test: (v: string): boolean => hasPlaceholder(v) };

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

/**
 * Значение пункта списка вида «- Метка: значение», ВКЛЮЧАЯ вложенный список под ним.
 *
 * Раньше брался только хвост той же строки, и самая естественная запись — когда находок
 * несколько и они идут вложенными пунктами — читалась как пустое значение. Главное
 * условие падения вердикта («любое подтверждённое расхождение из ревью») не срабатывало
 * ровно тогда, когда расхождений было больше одного.
 */
function bullet(report: string, label: RegExp): string | null {
  const lines = report.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t.startsWith('-') && !t.startsWith('*')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    if (!label.test(body)) continue;

    const colon = body.indexOf(':');
    const head = colon < 0 ? '' : body.slice(colon + 1).replace(/\*\*/g, '').trim();
    const indent = raw.length - raw.trimStart().length;

    const nested: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === '') continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      const item = next.trim().replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      // Курсивная подсказка формы — часть шаблона, а не находка рецензента.
      if (item.startsWith('_')) continue;
      if (item !== '') nested.push(item);
    }

    if (nested.length === 0) return head;
    return head === '' ? nested.join('; ') : `${head}; ${nested.join('; ')}`;
  }
  return null;
}

/**
 * «н/п», «нет», «—» и плейсхолдер — это «пусто», а не содержимое.
 *
 * Сравнение по ПОЛНОМУ значению, а не по префиксу. Пока стоял префикс, содержательная
 * находка, начинающаяся с тех же слов — «нет отката миграции при падении деплоя»,
 * «отсутствуют тесты на новый путь ошибки», — выбрасывалась вместе с настоящими
 * заглушками, и красный вердикт становился зелёным.
 */
const EMPTY_VALUES = new Set([
  'н/п',
  'нет',
  'нету',
  '—',
  '–',
  '-',
  'отсутствуют',
  'отсутствует',
  'не выявлено',
  'не выявлены',
  'не обнаружено',
  'нет замечаний',
]);

function isEmptyValue(v: string | null): boolean {
  if (v === null) return true;
  const t = v.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.;,]+$/, '').trim();
  if (t === '') return true;
  if (PLACEHOLDER.test(v)) return true;
  return EMPTY_VALUES.has(t);
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

/**
 * Запоминает подписанную строку неприменимости.
 *
 * Подпись проверяется тем же предикатом, что и решение человека в артефакте и закрытие
 * долга в наборе: имя И дата. Планка «две буквы в ячейке» стояла ровно на том пути,
 * который делает красный вердикт зелёным — снятии `⏭` с обязательного гейта, — и была
 * самой слабой из трёх. Дату здесь требуем не для формальности: она отличает решение,
 * принятое по этому diff'у, от строки, скопированной из прошлого отчёта.
 */
function rememberInapplicable(into: Map<string, string>, name: string, who: string): void {
  if (name === '' || PLACEHOLDER.test(name)) return;
  if (!isSignedByHuman(who)) return;
  into.set(gateKey(name), who.trim());
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

    // Порядок веток значим: СНАЧАЛА статусы. Пока первой стояла неприменимость, таблица
    // естественной формы «Гейт | Статус | Утвердил» целиком уходила в неё и делала
    // continue: все статусы терялись, каждый включённый гейт попадал в «не отчитался»,
    // и вердикт краснел без единой настоящей причины.
    if (gateCol >= 0 && statusCol >= 0) {
      for (const row of t.rows) {
        const name = row[gateCol] ?? '';
        if (name === '' || PLACEHOLDER.test(name)) continue;
        const st = parseGateStatus(row[statusCol] ?? '');
        // Строка есть, а статуса в ней нет — это не «прошёл». Гейт со стёртым статусом
        // получает `⏭` и роняет вердикт, как и не запускавшийся.
        gateStatuses.set(gateKey(name), st ?? '⏭');

        // Подпись неприменимости может стоять в той же таблице — читаем её здесь же.
        if (signedCol >= 0) rememberInapplicable(inapplicable, name, row[signedCol] ?? '');
      }
      continue;
    }

    // Отдельная таблица неприменимости: имя гейта + кто подписал, колонки «Статус» нет.
    if (gateCol >= 0 && signedCol >= 0) {
      for (const row of t.rows) {
        rememberInapplicable(inapplicable, row[gateCol] ?? '', row[signedCol] ?? '');
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
  /** Гейты, где отчёт и прогон разошлись. Побеждает ХУДШИЙ из двух статусов. */
  disagreements: string[];
}

/**
 * Строгость статуса: чем больше число, тем хуже исход.
 *
 * `⏭` строже `✅`, потому что «не запускался» роняет вердикт, а `❌` строже всего.
 */
const SEVERITY: Record<GateStatus, number> = { '✅': 0, '⏭': 1, '❌': 2 };

/**
 * Итоговый статус гейта при расхождении отчёта и прогона.
 *
 * Берётся ХУДШИЙ, а не «прогон всегда прав». Правило «побеждает прогон» защищало от
 * рецензента, который перекрашивает красное в зелёное, но работало и в обратную сторону:
 * рецензент ставил `❌`, найдя расхождение, а фиктивный «прогон» гейта ревью (проверка
 * наличия файла субагента на диске) перебивал его зелёным — и виток уходил в коммит с
 * известным дефектом. Худший статус закрывает обе стороны сразу.
 */
function worst(a: GateStatus, b: GateStatus): GateStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function collectVerdictInput(i: CollectInput): CollectResult {
  const facts = readReport(i.report);
  const expected = gatesExpectedInReport(i.gates);
  const byRun = new Map(i.gateResults.map((r) => [gateKey(r.name), r]));

  const gates: VerdictInput['gates'] = [];
  const missing: string[] = [];
  const disagreements: string[] = [];

  for (const row of expected) {
    const key = gateKey(row.name);
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

    const status = run === undefined ? reported : worst(run.status, reported);
    if (run !== undefined && run.status !== reported) {
      disagreements.push(
        `гейт «${row.name}»: в отчёте ${reported}, фактический прогон дал ${run.status} — ` +
          `в вердикт идёт худший из двух (${status})`,
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
