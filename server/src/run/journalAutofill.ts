/**
 * Автозаполнение МЕХАНИЧЕСКИХ полей журнала chunk'а — рантаймом, до запуска модели.
 *
 * Замер серии r2 (`docs/model-runs.md`, `polza:ministral-14b`): модель написала код,
 * зелёный на всех девяти скрытых тестах, ДВА прогона подряд — и оба раза сгорела на
 * оформлении журнала: `FinalizeArtifact` отклонялся из-за плейсхолдеров, модель дочищала
 * бланк россыпью мелких Edit (15 за прогон) и исчерпывала лимит ходов. Номер chunk'а,
 * base_sha, бюджет попыток и сегодняшняя дата — не знания модели, а факты рантайма;
 * заставлять модель вписывать их инструментами значит продавать ей ходы на то, что
 * рантайм знает достовернее.
 *
 * Три границы, каждая — конструкцией:
 *  - **Только механическое.** Содержательные поля (точки правки, «что чинили») и решение
 *    человека («Подтвердил») не трогаются: строка с решением пропускается по контексту,
 *    остальное матчится по ТОЧНОМУ тексту плейсхолдера из шаблона — незнакомый
 *    плейсхолдер остаётся модели, а не заполняется догадкой.
 *  - **Ничего не сочиняется.** Неизвестный факт (нет git, дата одобрения плана не
 *    извлеклась) оставляет плейсхолдер как есть — его честно спросит страж.
 *  - **Страж бланка не слепнет.** Заполненный рантаймом журнал — всё ещё бланк для
 *    модели: вызывающий обязан снять снимок ПОСЛЕ подстановки и сравнивать «нетронутость»
 *    с ним (`SeededArtifact.snapshot`), иначе этап, не сделавший ничего, выглядел бы
 *    поработавшим.
 */

import { isDecisionLine, lineAt, placeholderRanges } from '../artifacts/artifact.ts';
import { LEADING_PIPE_SEPARATOR_RE, escapeCell, h2SectionRanges, splitRow } from '../md/table.ts';

export interface ChunkJournalFacts {
  chunk: number;
  slug: string;
  /** Сегодня, ISO — дата первой строки таблицы попыток. */
  date: string;
  /** HEAD на момент старта chunk'а. `null` — не git-репозиторий или нет коммитов. */
  baseSha: string | null;
  attemptBudget: number;
  /** Дата одобрения плана из его поля решения. `null` — не извлеклась, поле не трогаем. */
  planApprovedOn: string | null;
}

/**
 * Общая механика автозаполнения механических плейсхолдеров: диапазоны с конца (сплайс не
 * сдвигает необработанные позиции), строка-контекст, пропуск строк решений человека
 * (`isDecisionLine` — единый источник меток), значение из таблицы вызывающего.
 * `null` от `valueFor` — не наш плейсхолдер, остаётся как есть. Идемпотентно.
 *
 * Вынесена из `autofillChunkJournal`: отчёт приёмки (`verifyAutofill.ts`) повторял её
 * дословно, и правка механики чинилась бы в одном файле из двух.
 */
export function fillMechanicalPlaceholders(
  text: string,
  valueFor: (inner: string, line: string) => string | null,
): { text: string; filled: number } {
  let out = text;
  let filled = 0;
  for (const range of [...placeholderRanges(text)].reverse()) {
    const inner = range.text.slice(1, -1);
    const line = lineAt(text, range.start);
    // Жирная метка поля решения («**Подтвердил:**») — поле человека, пропускается.
    // Строка «**План:** …, одобрение от ‹дата›» под правило не попадает: жирная метка
    // там «План», а дата — механический факт уже принятого решения из plan.md.
    if (isDecisionLine(line)) continue;
    const value = valueFor(inner, line);
    if (value === null) continue;
    out = out.slice(0, range.start) + value + out.slice(range.end);
    filled++;
  }
  return { text: out, filled };
}

/**
 * Значение для механического плейсхолдера. `null` — не наш: содержательный, решение
 * человека либо факт, которого у рантайма нет.
 */
function valueFor(inner: string, line: string, f: ChunkJournalFacts): string | null {
  if (inner === 'N') return String(f.chunk);
  if (inner === 'название витка') return f.slug;
  if (inner.startsWith('base_sha')) return f.baseSha;
  if (inner.startsWith('число из строки набора')) return String(f.attemptBudget);
  if (inner.startsWith('passed / retry')) return 'ещё не проверялась';
  if (inner === 'дата') {
    // Дата в строке таблицы попыток — сегодняшняя; «одобрение от ‹дата›» — дата решения
    // по плану, и если рантайм её не извлёк, поле остаётся: сочинять дату решения нельзя.
    if (line.trimStart().startsWith('|')) return f.date;
    if (line.includes('**План:**')) return f.planApprovedOn;
    return null;
  }
  return null;
}

/**
 * Возвращает текст с заполненными механическими полями и их число. Идемпотентно:
 * заполненные поля плейсхолдерами быть перестают и повторный вызов их не видит.
 * `placeholderRanges` сам исключает цитаты и инлайн-код — легенда шапки не трогается.
 */
export function autofillChunkJournal(
  text: string,
  facts: ChunkJournalFacts,
): { text: string; filled: number } {
  return fillMechanicalPlaceholders(text, (inner, line) => valueFor(inner, line, facts));
}

const ATTEMPTS_HEADING_RE = /Попытки/i;

/**
 * «Итог» строки попытки K журнала chunk'а — рантайм, не модель (6.7): вердикт этапа 6
 * считает `verdict/verdict.ts` по факту, и модели нечего добавить, переписывая ЭТУ же
 * строку `Edit`'ом задним числом. `Edit` в наборе инструментов этапа 6 остаётся ради
 * этой строки и только ради неё (см. докстринг `verifyStage.tools`) — своего второго
 * повода трогать журнал у рецензента нет.
 *
 * Строка попытки ищется по ПЕРВОЙ колонке (номер K), а не по позиции: чужие строки
 * (шапка, `|---|---|`, попытки других K) не трогаются. Колонка «Итог» — ПОСЛЕДНЯЯ ячейка
 * строки, тем же соглашением, что и у шаблона методологии («К | Дата | Что чинили | Что
 * изменилось | Итог»); лишние/переставленные колонки корректно НЕ находятся — рантайм не
 * гадает по позиции без числа K, совпавшего явно.
 *
 * Идемпотентно и БЕЗУСЛОВНО: значение — вычисленный факт, а не догадка, и повторный
 * вызов с тем же вердиктом просто перезаписывает ту же строку тем же текстом.
 */
export function autofillJournalOutcome(
  journalText: string,
  attempt: number,
  outcome: string,
): { text: string; filled: number } {
  const range = h2SectionRanges(journalText, ATTEMPTS_HEADING_RE)[0];
  if (range === undefined) return { text: journalText, filled: 0 };

  const before = journalText.slice(0, range.start);
  const section = journalText.slice(range.start, range.end);
  const after = journalText.slice(range.end);

  const key = String(attempt);
  let filled = 0;
  const newSection = section
    .split('\n')
    .map((line) => {
      // CRLF: журнал живёт рядом с остальными шаблонами методологии и несёт `\r\n` так
      // же, как они. Строка, которую эта функция ПЕРЕПИСЫВАЕТ, обязана вернуть свой `\r`
      // обратно — иначе именно эта строка таблицы становится LF, а соседние нетронутые
      // остаются CRLF (тот же приём, что уже применяет `closeAnsweredQuestions`; найдено
      // ревью code-review-all, 2026-09-19).
      const hadCR = line.endsWith('\r');
      const bare = hadCR ? line.slice(0, -1) : line;
      const trimmed = bare.trim();
      if (!trimmed.startsWith('|') || LEADING_PIPE_SEPARATOR_RE.test(trimmed)) return line;
      const cells = splitRow(trimmed);
      if (cells.length < 2 || (cells[0] ?? '').trim() !== key) return line;
      const last = cells.length - 1;
      const newCell = escapeCell(outcome);
      if ((cells[last] ?? '').trim() === newCell) return line; // уже то же значение
      cells[last] = newCell;
      filled++;
      const rebuilt = `| ${cells.join(' | ')} |`;
      return hadCR ? `${rebuilt}\r` : rebuilt;
    })
    .join('\n');

  return { text: before + newSection + after, filled };
}
