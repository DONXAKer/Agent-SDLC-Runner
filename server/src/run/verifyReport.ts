/**
 * Отчёт приёмки из СТРУКТУРИРОВАННЫХ записей модели, а не из её markdown.
 *
 * Зачем. Форма отчёта — второй по частоте класс отказа дешёвого рецензента после ходов:
 * колонка `№` вместо `id`, разъехавшаяся труба, статус словом. Вердикт при этом считается
 * по пустому входу («в отчёте не прочитан ни один гейт и ни один пункт»), то есть цена
 * ошибки оформления равна цене несделанной работы. Инструменты `RecordClaim` и
 * `RecordFinding` снимают у модели саму задачу оформления: она называет id, статус и
 * место, а таблицу рисует рантайм — и та разбирается `verdict/collect.ts` по построению.
 *
 * Что здесь НЕ делается:
 *  - записи не отменяют написанного моделью: заполняются строки-плейсхолдеры и
 *    дописываются недостающие, а чужой текст не стирается. Модель, справившаяся с формой
 *    сама, ничего не теряет;
 *  - записи не пишутся на диск отсюда. Отчёт уходит одним нормализованным `Write`
 *    рантайма — через политику и гейт одобрения, как любая запись;
 *  - находка БЕЗ ссылки на место не выбрасывается и не роняет вердикт: она уходит
 *    отдельной строкой «без привязки». Требование ссылки задумано против оформителя,
 *    который закрывает бланк, ничего не проверив, — а не против рецензента, который
 *    что-то увидел, но не смог показать пальцем.
 */

import type { ClaimStatus, FindingSection } from '@sdlc-runner/shared';

import { escapeCell, splitRow } from '../md/table.ts';

export interface ClaimRecord {
  id: string;
  status: ClaimStatus;
  evidence: string;
  whatToFix: string | null;
}

export interface FindingRecord {
  section: FindingSection;
  text: string;
  evidence: string;
  /** Нашлась ли ссылка на место в патче попытки или в дереве. */
  anchored: boolean;
}

/** Однострочная ячейка: переносы и трубы в таблице жить не могут. */
function cell(text: string, max = 240): string {
  const one = text.replace(/\s*\r?\n\s*/g, '; ').trim();
  const cut = one.length > max ? `${one.slice(0, max)}…` : one;
  return escapeCell(cut) === '' ? '—' : escapeCell(cut);
}

/** Границы секции по заголовку: от строки заголовка до следующего того же уровня. */
function sectionRange(lines: readonly string[], title: RegExp): { from: number; to: number } | null {
  let from = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]!.trim());
    if (h === null) continue;
    if (from < 0) {
      if (title.test(h[2]!.trim())) {
        from = i;
        level = h[1]!.length;
      }
      continue;
    }
    if (h[1]!.length <= level) return { from, to: i };
  }
  return from < 0 ? null : { from, to: lines.length };
}

const CLAIM_ID = /^(claim-\d+)\b/i;

function idOf(row: string): string | null {
  if (!row.trimStart().startsWith('|')) return null;
  const first = (splitRow(row)[0] ?? '').replace(/`/g, '').trim();
  const m = CLAIM_ID.exec(first);
  return m === null ? null : m[1]!.toLowerCase();
}

/**
 * Строка таблицы пунктов по числу колонок ЗАГОЛОВКА, а не по фиксированной пятёрке.
 *
 * Шаблон эталона правится независимо от рантайма, и приколоченное число колонок разъехалось
 * бы с ним молча: разъехавшаяся строка читается разбором как сдвинутый статус, то есть
 * вердикт краснел бы по несуществующей причине.
 */
function claimRow(columns: number, r: ClaimRecord, title: string): string {
  const cells = [cell(r.id), cell(title), r.status, cell(r.evidence), cell(r.whatToFix ?? 'н/п')];
  const fitted = columns >= cells.length ? [...cells, ...Array(columns - cells.length).fill('—')] : cells.slice(0, columns);
  return `| ${fitted.join(' | ')} |`;
}

const SECTION_TITLE: Record<FindingSection, RegExp> = {
  review: /^2\./,
  scope: /^3\./,
  invariant: /^4\./,
  regression: /^5\./,
};

/**
 * Как находка выглядит в своей секции.
 *
 * Формулировки не произвольные: их читает `verdict/collect.ts` — «Подтверждённое
 * расхождение» в §2, «нарушен:» в §4, любой непустой пункт в §5. Разойтись здесь с
 * разбором значит записать находку так, что вердикт её не увидит.
 */
function findingLine(r: FindingRecord): string {
  const where = r.evidence.trim() === '' ? '' : ` (${r.evidence.trim()})`;
  switch (r.section) {
    case 'review':
      return `- Подтверждённое расхождение: ${r.text.trim()}${where}`;
    case 'scope':
      return `- ${r.text.trim()}${where}`;
    case 'invariant':
      return `- ${r.text.trim()} — нарушен: ${r.evidence.trim() === '' ? r.text.trim() : r.evidence.trim()}`;
    case 'regression':
      return `- ${r.text.trim()}${where}`;
  }
}

export interface RenderResult {
  text: string;
  /** Сколько строк отчёта заполнено записями. */
  filled: number;
}

/**
 * Вносит записи модели в отчёт приёмки.
 *
 * Идемпотентна по пунктам: повторная запись того же `claim-N` заменяет строку, а не
 * добавляет вторую — иначе вердикт увидел бы один пункт дважды и свёл бы его по худшему
 * из двух собственных мнений модели.
 */
export function renderRecords(
  text: string,
  records: { claims: readonly ClaimRecord[]; findings: readonly FindingRecord[] },
): RenderResult {
  const lines = text.split('\n');
  let filled = 0;

  // ── §1: таблица пунктов приёмки ──────────────────────────────────────────
  const claims = records.claims;
  if (claims.length > 0) {
    const range = sectionRange(lines, /^1\./);
    if (range !== null) {
      let tableStart = -1;
      let tableEnd = -1;
      for (let i = range.from; i < range.to; i++) {
        const isRow = lines[i]!.trimStart().startsWith('|');
        if (isRow && tableStart < 0) tableStart = i;
        if (isRow) tableEnd = i + 1;
        else if (tableStart >= 0) break;
      }

      if (tableStart >= 0) {
        const columns = splitRow(lines[tableStart]!).length;
        const rest: ClaimRecord[] = [];
        for (const r of claims) {
          const at = lines.findIndex((l, k) => k >= tableStart && k < tableEnd && idOf(l) === r.id);
          if (at < 0) {
            rest.push(r);
            continue;
          }
          // Текст пункта берётся из существующей строки: его писал не рецензент, а форма,
          // и подменять его пересказом значило бы терять сверку по формулировке.
          const title = (splitRow(lines[at]!)[1] ?? '').trim();
          lines[at] = claimRow(columns, r, title === '' ? '—' : title);
          filled++;
        }
        // Строки-образца в шаблоне (`claim-1 | ‹начало пункта…›`) может не быть под нужный
        // id: недостающие пункты дописываются в конец таблицы, а не теряются.
        if (rest.length > 0) {
          const appended = rest.map((r) => claimRow(columns, r, '—'));
          lines.splice(tableEnd, 0, ...appended);
          filled += appended.length;
        }
      }
    }
  }

  // ── §2–§5: находки ───────────────────────────────────────────────────────
  const anchored = records.findings.filter((f) => f.anchored);
  const unanchored = records.findings.filter((f) => !f.anchored);

  for (const section of ['review', 'scope', 'invariant', 'regression'] as const) {
    const mine = anchored.filter((f) => f.section === section);
    if (mine.length === 0) continue;
    const range = sectionRange(lines, SECTION_TITLE[section]);
    if (range === null) continue;

    // Вставка сразу после заголовка и курсивной подсказки формы: находка обязана быть
    // видна первой, а не после списка шаблонных «н/п».
    let at = range.from + 1;
    while (at < range.to && (lines[at]!.trim() === '' || lines[at]!.trim().startsWith('_'))) at++;
    const block = mine.map(findingLine);
    lines.splice(at, 0, ...block);
    filled += block.length;
  }

  // Находки без привязки — одной помеченной строкой в §2 и НИ В ОДНОЙ из разбираемых
  // форм: вердикт их не считает (доказательства нет), но и потерять их нельзя — оператор
  // обязан их видеть, а качество рецензента по ним и оценивается.
  if (unanchored.length > 0) {
    const range = sectionRange(lines, /^2\./);
    if (range !== null) {
      const block = [
        '- Замечания без привязки к месту _(в вердикт не идут — ссылка не подтвердилась)_:',
        ...unanchored.map((f) => `  - (${f.section}) ${f.text.trim()}`),
      ];
      lines.splice(range.to, 0, ...block);
      filled += unanchored.length;
    }
  }

  return { text: lines.join('\n'), filled };
}

/**
 * Указывает ли ссылка на место, которое существует.
 *
 * Планка намеренно низкая: достаточно, чтобы В ССЫЛКЕ нашлось хоть одно слово, которое
 * есть в патче попытки или в дереве — имя файла, символа, теста. Это отсекает
 * «оформителя», у которого в колонке «Чем подтверждён» стоит «проверено» или «см. код»,
 * и не отсекает рецензента, который цитирует место своими словами.
 */
export function anchorFound(evidence: string, haystack: string): boolean {
  const tokens = evidence
    .split(/[^\p{L}\p{N}_./\\-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t));
  if (tokens.length === 0) return false;
  return tokens.some((t) => haystack.includes(t));
}
