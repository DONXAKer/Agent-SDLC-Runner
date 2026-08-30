/**
 * Экстрактор ответов человека из clarification-report.md.
 *
 * Один экстрактор на двух потребителей (карточка фактов в промпте chunk и гейт «Ответы
 * человека в коде») — эти тесты и есть его контракт.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractHumanFacts, literalPattern, literalsOf } from '../src/artifacts/humanFacts.ts';

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
      '## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что изменилось |\n|---|---|---|---|---|\n' +
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

  it('нецелый процент даёт точную дробную форму, а не двоичный артефакт', () => {
    // Ревью (К10): 8,2% давал accepted '0.08199999999999999' — форму, которой в коде
    // не бывает, и точный перенос ответа краснел.
    const lits = literalsOf('8,2% надбавки');
    deepStrictEqual(lits[0]?.accepted, ['8,2', '8.2', '0.082']);
  });
});

describe('literalPattern — границы токена и экранирование', () => {
  it('буква не граница: «64» не матчится в base64 (симметрия с извлечением)', () => {
    strictEqual(literalPattern('64').test("toString('base64')"), false);
    strictEqual(literalPattern('64').test('лимит 64 КБ'), true);
  });

  it('«90» не матчится в 190 и 903', () => {
    strictEqual(literalPattern('90').test('x = 190;'), false);
    strictEqual(literalPattern('90').test('port 903'), false);
    strictEqual(literalPattern('90').test('rate = 90;'), true);
  });

  it('метасимволы литерала экранируются — «2) случай» не роняет RegExp', () => {
    // Ревью (К9): без экранирования SyntaxError валил весь этап 6.
    strictEqual(literalPattern('2) случай').test('тут 2) случай описан'), true);
    strictEqual(literalPattern('1+2').test('сумма 1+2 готова'), true);
  });
});
