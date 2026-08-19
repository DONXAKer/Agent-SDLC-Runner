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

import type { GateRunResult, Verdict } from '@sdlc-runner/shared';

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

/** Размер патча: сколько файлов тронуто и сколько строк изменено. */
function patchSize(patch: string): { files: number; lines: number } {
  const files = new Set<string>();
  let lines = 0;
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m !== null) {
      files.add((m[1] ?? '').trim());
      continue;
    }
    if (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) lines++;
  }
  return { files: files.size, lines };
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
