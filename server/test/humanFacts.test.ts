/**
 * Экстрактор ответов человека из clarification-report.md.
 *
 * Один экстрактор на двух потребителей (карточка фактов в промпте chunk и гейт «Ответы
 * человека в коде») — эти тесты и есть его контракт.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractHumanFacts, literalsOf } from '../src/artifacts/humanFacts.ts';

const REPORT = `# Вопросы и ответы: Надбавка

## Вопросы и ответы
_легенда_

| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |
|---|---|---|---|---|
| 1 | Ставка для суммы >300см? | да | 90% от базовой цены зоны; ставки не складываются | claim-3 |
| 2 | Как в зоне far? | да | на общих основаниях, исключения нет | claim-7 |
| 3 | Расширять ли scope? | нет | (пропущено) — стаб вернул fallback | ничего |
| 4 | ‹вопрос› | ‹да/нет› | ‹ответ› / (пропущено) | ‹что поправлено› |

## Уточнённое требование и подход
текст
`;

describe('extractHumanFacts', () => {
  it('берёт только настоящие ответы: без пропущенных и без плейсхолдеров', () => {
    const facts = extractHumanFacts(REPORT);
    deepStrictEqual(
      facts.map((f) => f.question),
      ['Ставка для суммы >300см?', 'Как в зоне far?'],
    );
  });

  it('ответ без литералов остаётся фактом, но с пустым списком литералов', () => {
    const facts = extractHumanFacts(REPORT);
    deepStrictEqual(facts[1]?.literals, []);
  });

  it('без секции «Вопросы и ответы» — пусто, а не исключение', () => {
    deepStrictEqual(extractHumanFacts('# Что-то другое\nтекст'), []);
  });

  it('номер строки с пометкой («1 (из intent.md)») не мешает разбору', () => {
    const facts = extractHumanFacts(
      '## Вопросы и ответы\n| # | В | Б | О | И |\n|---|---|---|---|---|\n' +
        '| 1 (из intent.md, этап 1) | Ставка? | да | 90% от цены | зафиксировано |\n',
    );
    strictEqual(facts.length, 1);
    strictEqual(facts[0]?.literals[0]?.shown, '90%');
  });
});

describe('literalsOf', () => {
  it('процент даёт обе формы написания: целую и дробную', () => {
    const lits = literalsOf('90% от базовой цены зоны');
    deepStrictEqual(lits[0], { shown: '90%', accepted: ['90', '0.9'] });
  });

  it('число без процента — как есть, вместе с контекстом порога', () => {
    const lits = literalsOf('порог 300 см, ставка 1.5');
    deepStrictEqual(
      lits.map((l) => l.shown),
      ['300', '1.5'],
    );
  });

  it('цитаты в «ёлочках», кавычках и бэктиках извлекаются', () => {
    const lits = literalsOf('назови поле «surcharge», модуль `oversize.ts`');
    deepStrictEqual(
      lits.map((l) => l.shown),
      ['«surcharge»', '«oversize.ts»'],
    );
  });

  it('число внутри слова литералом не считается', () => {
    deepStrictEqual(literalsOf('utf8-совместимо'), []);
  });
});
