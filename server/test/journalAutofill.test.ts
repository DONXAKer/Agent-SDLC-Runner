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

import { autofillChunkJournal, autofillJournalOutcome } from '../src/run/journalAutofill.ts';
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

describe('autofillJournalOutcome (6.7: «Итог» попытки пишет рантайм, не Edit модели)', () => {
  it('находит строку попытки по K и заменяет «Итог» вычисленным вердиктом', () => {
    const { text, filled } = autofillJournalOutcome(TEMPLATE, 1, 'passed');
    strictEqual(filled, 1);
    ok(text.includes('| 1 | ‹дата› | первая попытка | н/п | passed |'), text);
  });

  it('идемпотентно: то же значение повторно не считается изменением', () => {
    const once = autofillJournalOutcome(TEMPLATE, 1, 'passed');
    const twice = autofillJournalOutcome(once.text, 1, 'passed');
    strictEqual(twice.filled, 0);
    strictEqual(twice.text, once.text);
  });

  it('другой номер попытки — другая строка, остальные не трогаются', () => {
    const twoAttempts = [
      "# Журнал chunk'а 1: demo",
      '',
      '## Попытки',
      '',
      '| K | Дата | Что чинили | Что изменилось | Итог |',
      '|---|---|---|---|---|',
      '| 1 | 2026-09-01 | первая попытка | н/п | retry |',
      '| 2 | 2026-09-02 | чинили X | diff мал | ещё не проверялась |',
    ].join('\n');
    const { text, filled } = autofillJournalOutcome(twoAttempts, 2, 'escalate');
    strictEqual(filled, 1);
    ok(text.includes('| 1 | 2026-09-01 | первая попытка | н/п | retry |'), 'чужая строка задета');
    ok(text.includes('| 2 | 2026-09-02 | чинили X | diff мал | escalate |'), text);
  });

  it('строки с таким K нет — no-op, не падение', () => {
    const { text, filled } = autofillJournalOutcome(TEMPLATE, 5, 'passed');
    strictEqual(filled, 0);
    strictEqual(text, TEMPLATE);
  });

  it('секции «Попытки» нет — no-op, не падение', () => {
    const noSection = '# Журнал\nбез секции\n';
    const { text, filled } = autofillJournalOutcome(noSection, 1, 'passed');
    strictEqual(filled, 0);
    strictEqual(text, noSection);
  });

  it('шапка таблицы («K») не принимается за строку попытки', () => {
    const { text } = autofillJournalOutcome(TEMPLATE, 1, 'passed');
    ok(text.includes('| K | Дата | Что чинили | Что изменилось | Итог |'), 'шапка обязана остаться нетронутой');
  });

  it('CRLF: переписанная строка сохраняет `\\r`, соседние строки не переводятся на LF', () => {
    // Регрессия ревью (2026-09-19): строка, которую функция ПЕРЕПИСЫВАЕТ, собиралась из
    // уже обрезанного (`.trim()`) текста без обратного добавления `\r` — на CRLF-файле
    // именно эта строка становилась LF-only рядом с нетронутыми CRLF-строками.
    // Хвостовой `\n` перед конвертацией — иначе у ПОСЛЕДНЕЙ строки шаблона нет реальной
    // границы строки, на которой можно было бы проверить сохранение `\r`.
    const crlf = `${TEMPLATE}\n`.split('\n').join('\r\n');
    const { text, filled } = autofillJournalOutcome(crlf, 1, 'passed');
    strictEqual(filled, 1);
    ok(text.includes('| 1 | ‹дата› | первая попытка | н/п | passed |\r\n'), JSON.stringify(text));
    ok(text.includes('| K | Дата | Что чинили | Что изменилось | Итог |\r\n'), 'нетронутая шапка обязана остаться CRLF');
  });
});
