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
