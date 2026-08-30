/**
 * Автозаполнение механических полей журнала chunk'а (`journalAutofill.ts`).
 *
 * Сторожится: механика (номер, слаг, base_sha, бюджет, даты, «ещё не проверялась»)
 * заполняется; содержательное (точки правки) и решение человека («Подтвердил») не
 * трогаются НИКОГДА; неизвестный факт оставляет плейсхолдер; повторный вызов идемпотентен.
 * Фикстура — строки реального шаблона методологии (chunk-journal.template.md).
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { autofillChunkJournal } from '../src/run/journalAutofill.ts';
import type { ChunkJournalFacts } from '../src/run/journalAutofill.ts';

const TEMPLATE = [
  "# Журнал chunk'а ‹N›: ‹название витка›",
  '',
  '> Артефакты попыток лежат рядом: `chunk-‹N›-attempt-‹K›-diff.patch` — легенда с ‹…› в цитате.',
  '',
  '- **План:** `plan.md`, одобрение от ‹дата›',
  '- **База:** ‹base_sha — коммит, от которого считается diff›',
  '- **Бюджет попыток:** ‹число из строки набора «Бюджет итераций chunk\'а» / 3 — умолчание›',
  '',
  '## Место правки',
  '',
  '- Точки правки по итогам точечной разведки: ‹файл:символ, …›',
  '- **Подтвердил:** ‹имя› · ‹дата› / использовано одобрение плана',
  '',
  '## Попытки',
  '',
  '| K | Дата | Что чинили | Что изменилось | Итог |',
  '|---|---|---|---|---|',
  '| 1 | ‹дата› | первая попытка | н/п | ‹passed / retry / blocked_env / escalate / ещё не проверялась› |',
].join('\n');

const FACTS: ChunkJournalFacts = {
  chunk: 2,
  slug: 'demo-witок',
  date: '2026-08-30',
  baseSha: 'abc123def456',
  attemptBudget: 3,
  planApprovedOn: '2026-08-29',
};

describe('автозаполнение журнала chunk\'а', () => {
  it('механика заполняется, содержательное и решение человека — нет', () => {
    const { text, filled } = autofillChunkJournal(TEMPLATE, FACTS);

    ok(text.includes("# Журнал chunk'а 2: demo-witок"), 'заголовок не заполнен');
    ok(text.includes('одобрение от 2026-08-29'), 'дата одобрения плана не подставлена');
    ok(text.includes('- **База:** abc123def456'), 'base_sha не подставлен');
    ok(text.includes('- **Бюджет попыток:** 3'), 'бюджет не подставлен');
    ok(text.includes('| 1 | 2026-08-30 |'), 'дата попытки не подставлена');
    ok(text.includes('| ещё не проверялась |'), 'итог попытки не подставлен');

    // Не трогаем: содержательное, решение человека, легенду в цитате.
    ok(text.includes('‹файл:символ, …›'), 'содержательное поле разведки затронуто');
    ok(text.includes('**Подтвердил:** ‹имя› · ‹дата›'), 'решение человека затронуто');
    ok(text.includes('chunk-‹N›-attempt-‹K›-diff.patch'), 'легенда в цитате затронута');

    strictEqual(filled, 7, text);
  });

  it('неизвестный факт оставляет плейсхолдер: ничего не сочиняется', () => {
    const { text } = autofillChunkJournal(TEMPLATE, {
      ...FACTS,
      baseSha: null,
      planApprovedOn: null,
    });
    ok(text.includes('‹base_sha'), 'без git base_sha обязан остаться плейсхолдером');
    ok(text.includes('одобрение от ‹дата›'), 'без решения дата одобрения обязана остаться');
  });

  it('идемпотентно: повторный вызов ничего не меняет', () => {
    const first = autofillChunkJournal(TEMPLATE, FACTS);
    const second = autofillChunkJournal(first.text, FACTS);
    strictEqual(second.filled, 0);
    strictEqual(second.text, first.text);
  });
});
