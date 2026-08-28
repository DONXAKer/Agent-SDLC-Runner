/**
 * Журнал итераций витка: строка на каждый посчитанный вердикт.
 *
 * Истории попыток не было нигде. Состояние попытки рантайм честно обнуляет на следующей
 * (`resetAttemptState`), а буфер шины вытесняет старые события с начала — то есть к концу
 * витка ответ на вопрос «сколько итераций и на чём именно они сгорели» не восстанавливался
 * ни из памяти, ни из ленты. Без него «приемлемый срок итераций» неизмерим, а тюнинг
 * промптов и профилей опирается на впечатление.
 *
 * Что здесь записывается: только то, что рантайм видел САМ — исход вердикта, его причины
 * дословно, статусы гейтов из фактического прогона, размер патча. Пересказа модели тут нет
 * и быть не должно: журнал существует, чтобы проверять рассказ, а не повторять его.
 *
 * Строка ДОПИСЫВАЕТСЯ. Попытки не перезаписываются нигде в этом коде по той же причине, по
 * которой не перезаписываются их патчи: стёртая улика не восстанавливается.
 */

import type {
  GateRunResult,
  IterationSummary,
  Verdict,
  VerdictAction,
} from '@sdlc-runner/shared';

import { columnIndex, parseTables } from '../md/table.ts';

// Разбор патча общий на кодовую базу: свой считал строку кода, начинающуюся с `++`,
// заголовком файла — журнал печатал «Файлов: 2» для патча одного файла.
import { patchSize } from '../diff/parse.ts';

export interface IterationRecord {
  chunk: number;
  attempt: number;
  verdict: Verdict;
  /** Фактический прогон гейтов этой попытки — статусы берутся отсюда, а не из отчёта. */
  gates: readonly GateRunResult[];
  /** Патч попытки: по нему считается размер изменения. */
  patch: string;
  /** Близость к патчу прошлой попытки, если считалась. */
  closeness: number | null;
  /** Патч дословно совпал с предыдущим. */
  noProgress: boolean;
  at: Date;
}

const HEADER = [
  '# Журнал итераций витка',
  '',
  '> Пишет рантайм по факту посчитанного вердикта. Здесь только то, что рантайм видел сам:',
  '> исход, причины дословно, статусы фактического прогона гейтов и размер патча. Колонка',
  '> «Заметка» — место для человека, и пустой она означает ровно «человек не писал», а не',
  '> «замечаний нет».',
  '',
  '| Когда | Chunk | Попытка | Исход | Файлов | Строк | Совпадение с прошлым | Причины | Заметка |',
  '|---|---|---|---|---|---|---|---|---|',
].join('\n');

/** Ячейка таблицы: перевод строки и вертикальная черта ломают разметку. */
function cell(v: string): string {
  return v.split('\n').join(' ').split('|').join('\\|').trim();
}

/** Одна строка журнала. Возвращается без завершающего перевода строки. */
export function iterationRow(r: IterationRecord): string {
  const size = patchSize(r.patch);
  const failedGates = r.gates.filter((g) => g.status !== '✅').map((g) => `${g.status} ${g.name}`);

  const outcome = r.verdict.passed ? '✅ passed' : `❌ ${r.verdict.action}`;
  const closeness =
    r.noProgress
      ? 'патч тот же'
      : r.closeness === null
        ? '—'
        : `${Math.round(r.closeness * 100)}%`;

  // Причины и упавшие гейты — в одну колонку: разносить их по двум значило бы обещать, что
  // они независимы, тогда как упавший гейт обычно и есть причина.
  const reasons = [...r.verdict.reasons, ...failedGates];

  const cells = [
    r.at.toISOString().slice(0, 16).replace('T', ' '),
    String(r.chunk),
    String(r.attempt),
    outcome,
    String(size.files),
    String(size.lines),
    closeness,
    reasons.length === 0 ? '—' : reasons.join('; '),
    // Колонка человека остаётся пустой намеренно: пустая означает «человек не писал», а не
    // «замечаний нет», и заполнять её за него нельзя.
    '',
  ];
  return `| ${cells.map(cell).join(' | ')} |`;
}

/**
 * Журнал с дописанной строкой. Существующий текст не трогается, шапка добавляется только
 * когда файла ещё нет.
 */
export function appendIteration(existing: string, r: IterationRecord): string {
  const base = existing.trim() === '' ? HEADER : existing.replace(/\s+$/, '');
  return `${base}\n${iterationRow(r)}\n`;
}

/**
 * Читает журнал с диска обратно в историю попыток.
 *
 * Нужен, потому что журнал — ЕДИНСТВЕННАЯ истина об истории попыток. Пока панель попыток
 * питалась только накопителем в памяти, виток, открытый после перезапуска сервиса
 * (сценарий, который методология объявляет поддержанным), показывал «попытка 3» и пустую
 * панель: номер попытки восстанавливался с диска, а история — нет.
 *
 * Разбор нестрогий: строка, которую не удалось прочитать, пропускается. Журнал —
 * наблюдаемость, и битая строка не должна ронять открытие витка.
 */
export function parseIterations(text: string): IterationSummary[] {
  const table = parseTables(text).find((t) => columnIndex(t.header, 'Chunk') !== -1);
  if (table === undefined) return [];

  const idx = {
    at: columnIndex(table.header, 'Когда'),
    chunk: columnIndex(table.header, 'Chunk'),
    attempt: columnIndex(table.header, 'Попытка'),
    outcome: columnIndex(table.header, 'Исход'),
    closeness: columnIndex(table.header, 'Совпадение с прошлым'),
    reasons: columnIndex(table.header, 'Причины'),
  };
  if (Object.values(idx).some((i) => i === -1)) return [];

  const out: IterationSummary[] = [];
  for (const row of table.rows) {
    const chunk = Number.parseInt(row[idx.chunk] ?? '', 10);
    const attempt = Number.parseInt(row[idx.attempt] ?? '', 10);
    if (!Number.isFinite(chunk) || !Number.isFinite(attempt)) continue;

    const outcome = (row[idx.outcome] ?? '').trim();
    const passed = outcome.startsWith('✅');
    // Действие берётся из той же ячейки, куда его пишет `iterationRow`. Неузнанное —
    // `retry`: это самый безобидный исход, и выдумывать `continue` за журнал нельзя.
    const rawAction = outcome.replace(/^[✅❌]\s*/, '').trim();
    const action: VerdictAction =
      rawAction === 'continue' || rawAction === 'escalate' || rawAction === 'blocked_env'
        ? rawAction
        : passed
          ? 'continue'
          : 'retry';

    const rawCloseness = (row[idx.closeness] ?? '').trim();
    const pct = /^(\d+)%$/.exec(rawCloseness);
    const closeness = pct === null ? null : Number(pct[1]) / 100;

    const rawReasons = (row[idx.reasons] ?? '').trim();
    out.push({
      chunk,
      attempt,
      passed,
      action,
      reasons: rawReasons === '' || rawReasons === '—' ? [] : rawReasons.split('; '),
      closeness,
      at: (row[idx.at] ?? '').trim().replace(' ', 'T'),
    });
  }
  return out;
}
