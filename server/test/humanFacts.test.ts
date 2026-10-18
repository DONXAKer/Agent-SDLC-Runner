/**
 * Экстрактор ответов человека из clarification-report.md.
 *
 * Один экстрактор на двух потребителей (карточка фактов в промпте chunk и гейт «Ответы
 * человека в коде») — эти тесты и есть его контракт.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clarificationResolutionBlock, clarificationResolutionProblem } from '../src/artifacts/clarificationResolution.ts';
import { escapeCell } from '../src/md/table.ts';

import {
  appendAnswerRows,
  askedQuestionCount,
  closeAnsweredQuestions,
  extractHumanFacts,
  literalPattern,
  literalsOf,
  openQuestions,
  renderAnswerRow,
  reopenUnverifiedQuestions,
  unaskedQuestions,
  unreflectedAnswers,
} from '../src/artifacts/humanFacts.ts';

it('не выдаёт запись рантайма об отсутствии вопросов за ответ человека', () => {
  const empty = ['## Вопросы и ответы', '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
    '|---|---|---|---|---|',
    '| — | по существу пусто — открытых вопросов нет; записано рантаймом | н/п | н/п | ничего |'].join('\n');
  deepStrictEqual(extractHumanFacts(empty), []);
  strictEqual(clarificationResolutionProblem('# План', empty), null);
});

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

  it('сокращённая шапка берётся позиционным запасным ходом, а не молча в ноль (ревью-3)', () => {
    const facts = extractHumanFacts(
      '## Вопросы и ответы\n| # | В | Б | О | И |\n|---|---|---|---|---|\n| 1 | Ставка? | да | 90% | зафикс |\n',
    );
    strictEqual(facts.length, 1);
    strictEqual(facts[0]?.answer, '90%');
  });

  it('таблица БЕЗ шапки: первая строка данных не выпадает из сверки (ревью-4)', () => {
    const facts = extractHumanFacts(
      '## Вопросы и ответы\n' +
        '| 1 | Ставка? | да | 90% | зафикс |\n' +
        '| 2 | Лимит? | да | 500 | зафикс |\n',
    );
    deepStrictEqual(
      facts.map((f) => f.answer),
      ['90%', '500'],
    );
  });

  it('смешанный режим (qi по имени, колонка ответа переименована) — пропуск, не чужая колонка (ревью-5)', () => {
    // ai=3 позиционно при qi-по-имени читал «Блокирующий» ответом (ложный факт answer='да').
    const facts = extractHumanFacts(
      '## Вопросы и ответы\n| # | Тема | Вопрос | Блокирующий | Решение |\n|---|---|---|---|---|\n' +
        '| 1 | ставки | Ставка? | да | 90% |\n',
    );
    deepStrictEqual(facts, []);
  });

  it('номер строки с пометкой («1 (из intent.md)») не мешает разбору', () => {
    const facts = extractHumanFacts(
      '## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что изменилось |\n|---|---|---|---|---|\n' +
        '| 1 (из intent.md, этап 1) | Ставка? | да | 90% от цены | зафиксировано |\n',
    );
    strictEqual(facts.length, 1);
    strictEqual(facts[0]?.literals[0]?.shown, '90%');
  });
  it('reconciles every nonempty human answer before plan approval', () => {
    const facts = extractHumanFacts(REPORT);
    strictEqual(facts.length, 2);
    const promptBlock = clarificationResolutionBlock(REPORT);
    ok(promptBlock);
    strictEqual(clarificationResolutionProblem('# plan\n', REPORT) !== null, true);
    strictEqual(clarificationResolutionProblem('# plan\n', '# no answers\n'), null);
    const tableRows = facts.map((_, i) => {
      const claim = i === 0 ? 'claim-3' : 'claim-7';
      const answerId = '\u043e\u0442\u0432\u0435\u0442-' + (i + 1);
      const confirmation = '\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442 ' + claim + ' \u0431\u0435\u0437 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439';
      return '| ' + answerId + ' | ' + claim + ' | ' + confirmation + ' |';
    });
    const approvedPlan = [
      '# Plan',
      '',
      '## \u0423\u0442\u043e\u0447\u043d\u0435\u043d\u0438\u044f \u0438 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u0435 \u0440\u0430\u0441\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u0439',
      '',
      '| ID \u043e\u0442\u0432\u0435\u0442\u0430 | \u0418\u0441\u0445\u043e\u0434\u043d\u044b\u0439 \u043f\u0443\u043d\u043a\u0442 | \u0420\u0435\u0448\u0435\u043d\u0438\u0435 |',
      '|---|---|---|',
      ...tableRows,
    ].join('\n');
    strictEqual(clarificationResolutionProblem(approvedPlan, REPORT, new Set(['claim-3', 'claim-7'])), null);
    strictEqual(clarificationResolutionProblem(approvedPlan, REPORT, new Set(['claim-3'])) !== null, true);
    const missingAnswer = approvedPlan.replace('| ' + '\u043e\u0442\u0432\u0435\u0442-2' + ' | claim-7 |', '| ' + '\u043e\u0442\u0432\u0435\u0442-9' + ' | claim-7 |');
    strictEqual(clarificationResolutionProblem(missingAnswer, REPORT) !== null, true);
    const unresolved = approvedPlan.replace('\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442 claim-3 \u0431\u0435\u0437 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439', 'unresolved');
    strictEqual(clarificationResolutionProblem(unresolved, REPORT) !== null, true);
  });

  it('keeps accepting the legacy plan table while old plans are being migrated', () => {
    const facts = extractHumanFacts(REPORT);
    const rows = facts.map((fact, index) => {
      const claim = index === 0 ? 'claim-3' : 'claim-7';
      const answerId = '\u043e\u0442\u0432\u0435\u0442-' + (index + 1);
      const resolution = '\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442 ' + claim + ' \u0431\u0435\u0437 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439';
      return `| ${answerId} | ${fact.question} | ${fact.answer} | ${claim} | ${resolution} |`;
    });
    const legacyPlan = [
      '# Plan',
      '## \u0423\u0442\u043e\u0447\u043d\u0435\u043d\u0438\u044f \u0438 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043d\u0438\u0435 \u0440\u0430\u0441\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u0439',
      '| ID \u043e\u0442\u0432\u0435\u0442\u0430 | \u0412\u043e\u043f\u0440\u043e\u0441 | \u041e\u0442\u0432\u0435\u0442 \u0447\u0435\u043b\u043e\u0432\u0435\u043a\u0430 | \u0418\u0441\u0445\u043e\u0434\u043d\u044b\u0439 \u043f\u0443\u043d\u043a\u0442 | \u0420\u0435\u0448\u0435\u043d\u0438\u0435 |',
      '|---|---|---|---|---|',
      ...rows,
    ].join('\n');
    strictEqual(clarificationResolutionProblem(legacyPlan, REPORT), null);
  });

});

/**
 * `unreflectedAnswers` (Р6, серия local6 2026-09-24): «Что изменилось в задаче» заполнено,
 * но не тем — числа/условия из ОТВЕТА человека в него не попали, и claim-N не назван.
 * Фикстура — дословно текст живого прогона (`vat-rounding`): ответ называет 10 % при
 * условии, «Что изменилось» пересказывает 20 % без единой цифры ответа.
 */
describe('unreflectedAnswers', () => {
  const table = (changed: string) =>
    '## Вопросы и ответы\n' +
    '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |\n' +
    '|---|---|---|---|---|\n' +
    `| 1 | Какую ставку льготы использовать? | да | Льготная ставка НДС — 10%. Применяется, только если ВСЕ позиции льготные. | ${changed} |\n`;

  it('живой случай: «Что изменилось» пересказывает 20% без единой цифры ответа (10%) — находка', () => {
    const stale = unreflectedAnswers(
      table('Invoice обновлён с логикой расчёта VAT: при opts.vat=\'std\' добавляется 20 % от subtotal'),
    );
    strictEqual(stale.length, 1);
    strictEqual(stale[0]?.question, 'Какую ставку льготы использовать?');
  });

  it('«Что изменилось» содержит литерал ответа (10%) — не находка', () => {
    strictEqual(unreflectedAnswers(table('Добавлена льготная ставка 10% для счетов, где все позиции reduced')).length, 0);
  });

  it('«Что изменилось» называет claim-N — не находка (законный адрес, поправит человек)', () => {
    strictEqual(unreflectedAnswers(table('см. claim-1')).length, 0);
  });

  it('«Что изменилось» пусто/плейсхолдер — не находка (общий страж завершения уже поймал бы это)', () => {
    strictEqual(unreflectedAnswers(table('‹что изменилось в задаче›')).length, 0);
    strictEqual(unreflectedAnswers(table('')).length, 0);
  });

  it('ответ без литералов — не проверяется вовсе: сверять нечем', () => {
    const noLiterals =
      '## Вопросы и ответы\n' +
      '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |\n' +
      '|---|---|---|---|---|\n' +
      '| 1 | Кратко? | нет | Ответа у меня нет, прочитай код сам. | что-то не по теме |\n';
    strictEqual(unreflectedAnswers(noLiterals).length, 0);
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

describe('closeAnsweredQuestions (3.1: рантайм закрывает intent.md чек-боксы за модель)', () => {
  const INTENT = [
    '# Задача: демо',
    '',
    '## Открытые вопросы',
    '',
    '- [ ] **[блокирующий]** Ставка для суммы >300см?',
    '- [ ] **[неблокирующий]** Как в зоне far?',
    '- [ ] **[неблокирующий]** Расширять ли scope?',
    '- [ ] **[блокирующий]** ‹вопрос›',
    '',
    '## Инварианты',
    '- [ ] это не чек-бокс вопросов, другая секция',
  ].join('\n');

  it('отвеченные вопросы закрываются с ответом; пропущенный и образец — нет', () => {
    const facts = extractHumanFacts(`
## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |
|---|---|---|---|---|
| 1 | Ставка для суммы >300см? | да | 90% от базовой цены зоны | claim-3 |
| 2 | Как в зоне far? | нет | на общих основаниях | claim-7 |
| 3 | Расширять ли scope? | нет | (пропущено) — стаб вернул fallback | ничего |
`);
    const { text, closed } = closeAnsweredQuestions(INTENT, facts);
    strictEqual(closed, 2);
    ok(text.includes('- [x] **[блокирующий]** Ставка для суммы >300см? — 90% от базовой цены зоны'), text);
    ok(text.includes('- [x] **[неблокирующий]** Как в зоне far? — на общих основаниях'), text);
    // Пропущенный остаётся открытым — уходит следующему витку (шаблон, «Отложено»).
    ok(text.includes('- [ ] **[неблокирующий]** Расширять ли scope?'), text);
    // Строка-образец без реального ответа не закрывается.
    ok(text.includes('- [ ] **[блокирующий]** ‹вопрос›'), text);
  });

  it('секция «Инварианты» не трогается — чек-бокс той же формы, но другая секция', () => {
    const facts = extractHumanFacts(`
## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что изменилось |
|---|---|---|---|---|
| 1 | это не чек-бокс вопросов, другая секция | да | ответ | ничего |
`);
    const { text } = closeAnsweredQuestions(INTENT, facts);
    ok(text.includes('- [ ] это не чек-бокс вопросов, другая секция'), text);
  });

  it('фактов нет — текст не трогается, closed=0', () => {
    const { text, closed } = closeAnsweredQuestions(INTENT, []);
    strictEqual(closed, 0);
    strictEqual(text, INTENT);
  });

  it('секции «Открытые вопросы» нет — no-op, не падение', () => {
    const noSection = '# Задача: демо\n\n## Коротко\nчто-то\n';
    const facts = extractHumanFacts('## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что |\n|---|---|---|---|---|\n| 1 | x | да | y | z |\n');
    const { text, closed } = closeAnsweredQuestions(noSection, facts);
    strictEqual(closed, 0);
    strictEqual(text, noSection);
  });

  it('идемпотентно: повторный вызов на уже закрытой строке не дублирует ответ', () => {
    const facts = extractHumanFacts(`
## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что |
|---|---|---|---|---|
| 1 | Ставка для суммы >300см? | да | 90% от базовой цены зоны | claim-3 |
`);
    const once = closeAnsweredQuestions(INTENT, facts);
    const twice = closeAnsweredQuestions(once.text, facts);
    strictEqual(twice.closed, 0);
    strictEqual(twice.text, once.text);
  });

  it('регистр и пробелы в вопросе не мешают сопоставлению', () => {
    const facts = extractHumanFacts(`
## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что |
|---|---|---|---|---|
| 1 |   ставка ДЛЯ суммы >300см?   | да | 90% | claim-3 |
`);
    const { closed, text } = closeAnsweredQuestions(INTENT, facts);
    strictEqual(closed, 1);
    ok(text.includes('- [x] **[блокирующий]** Ставка для суммы >300см? — 90%'), text);
  });

  it('CRLF (шаблоны методологии): строка закрывается, `\\r` сохраняется на месте', () => {
    // Регрессия найдена сверкой с живым шаблоном: `(.+)$` без отдельной обработки `\r`
    // не матчил строку вовсе, и она молча оставалась открытой на настоящем chunk-1-…
    // документе, хотя на LF-фикстурах тест был зелёным.
    const crlfIntent = INTENT.split('\n').join('\r\n');
    const facts = extractHumanFacts(`
## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что |
|---|---|---|---|---|
| 1 | Ставка для суммы >300см? | да | 90% | claim-3 |
`);
    const { closed, text } = closeAnsweredQuestions(crlfIntent, facts);
    strictEqual(closed, 1);
    ok(text.includes('- [x] **[блокирующий]** Ставка для суммы >300см? — 90%\r\n'), JSON.stringify(text));
    // Нетронутые строки остаются CRLF — второй стиль окончания строк не заводится.
    ok(text.includes('- [ ] **[неблокирующий]** Как в зоне far?\r\n'), JSON.stringify(text));
  });
});

describe('openQuestions (3.4: вопрос человеку задаёт рантайм)', () => {
  const INTENT = [
    '## Открытые вопросы',
    '',
    '- [ ] **[блокирующий]** Ставка для суммы >300см?',
    '- [x] **[неблокирующий]** Уже закрытый, не в списке',
    '- [ ] **[блокирующий]** ‹вопрос›',
  ].join('\n');

  const EXPLORATION = ['## Всплывшие вопросы', '', '- [ ] **[неблокирующий]** Нужен ли кеш?'].join('\n');

  it('собирает открытые вопросы из обоих отчётов, закрытые и образец пропускает', () => {
    const qs = openQuestions(INTENT, EXPLORATION);
    deepStrictEqual(qs, [
      { question: 'Ставка для суммы >300см?', blocking: true, source: 'intent' },
      { question: 'Нужен ли кеш?', blocking: false, source: 'exploration' },
    ]);
  });

  it('открывает обратно галочку модели без ответа человека и сохраняет закрытую с human fact', () => {
    const checked = INTENT
      .replace('- [x] **[неблокирующий]** Уже закрытый, не в списке\n', '')
      .replace('- [ ] **[блокирующий]** Ставка для суммы >300см?', '- [x] **[блокирующий]** Ставка для суммы >300см?');
    const facts = extractHumanFacts(REPORT);
    const withFact = reopenUnverifiedQuestions(checked, facts);
    strictEqual(withFact.reopened, 0);
    ok(withFact.text.includes('- [x] **[блокирующий]** Ставка для суммы >300см?'));

    const noFact = reopenUnverifiedQuestions(checked, []);
    strictEqual(noFact.reopened, 1);
    ok(noFact.text.includes('- [ ] **[блокирующий]** Ставка для суммы >300см?'));
  });

  it('оба текста пусты или без секции — пустой список, не падение', () => {
    deepStrictEqual(openQuestions('', ''), []);
    deepStrictEqual(openQuestions('# Задача\nбез секции', '# Отчёт\nбез секции'), []);
  });

  it('тег без явной пометки считается блокирующим по умолчанию', () => {
    const intent = '## Открытые вопросы\n\n- [ ] Вопрос без тега важности\n';
    deepStrictEqual(openQuestions(intent, ''), [{ question: 'Вопрос без тега важности', blocking: true, source: 'intent' }]);
  });

  it('один и тот же вопрос в intent.md и exploration-report.md — дедуп, а не двойной вопрос (регрессия ревью, 2026-09-19)', () => {
    const intent = '## Открытые вопросы\n\n- [ ] **[блокирующий]** Нужен ли отдельный кеш?\n';
    // Регистр/пробелы отличаются — тот же нормализующий приём, что уже применяет unaskedQuestions.
    const expl = '## Всплывшие вопросы\n\n- [ ] **[неблокирующий]**   нужен ЛИ отдельный кеш?\n';
    deepStrictEqual(openQuestions(intent, expl), [
      { question: 'Нужен ли отдельный кеш?', blocking: true, source: 'intent' },
    ]);
  });

  it('нестандартный отступ между скобками («- [  ] …», два пробела) — тоже открыт (регрессия ревью, 2026-09-19)', () => {
    const intent = '## Открытые вопросы\n\n- [  ] Вопрос с двумя пробелами в чек-боксе\n';
    deepStrictEqual(openQuestions(intent, ''), [
      { question: 'Вопрос с двумя пробелами в чек-боксе', blocking: true, source: 'intent' },
    ]);
  });
});

describe('unaskedQuestions / askedQuestionCount', () => {
  const OPEN = [
    { question: 'Ставка для суммы >300см?', blocking: true, source: 'intent' as const },
    { question: 'Нужен ли кеш?', blocking: false, source: 'exploration' as const },
  ];

  it('вопрос уже отвеченный строкой отчёта — не переспрашивается', () => {
    const report = [
      '## Вопросы и ответы',
      '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
      '|---|---|---|---|---|',
      '| 1 | Ставка для суммы >300см? | да | 90% | claim-3 |',
    ].join('\n');
    deepStrictEqual(unaskedQuestions(OPEN, report), [OPEN[1]]);
    strictEqual(askedQuestionCount(report), 1);
  });

  it('вопрос, отвеченный «(пропущено)» — тоже не переспрашивается (идемпотентность, не только факт)', () => {
    const report = [
      '## Вопросы и ответы',
      '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
      '|---|---|---|---|---|',
      '| 1 | Ставка для суммы >300см? | да | (пропущено) | ничего |',
    ].join('\n');
    deepStrictEqual(unaskedQuestions(OPEN, report), [OPEN[1]]);
  });

  it('таблицы ещё нет — все вопросы свежие, счёт 0', () => {
    const report = '## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что |\n|---|---|---|---|---|\n| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› | ‹что› |\n';
    deepStrictEqual(unaskedQuestions(OPEN, report), OPEN);
    strictEqual(askedQuestionCount(report), 0);
  });

  it('«ё»/«е» в вопросе не считаются разными вопросами (регрессия ревью, 2026-09-19)', () => {
    const withYo = [{ question: 'Нужен ли ещё один кеш?', blocking: false, source: 'intent' as const }];
    const report = [
      '## Вопросы и ответы',
      '| # | Вопрос | Блокирующий | Ответ человека | Что |',
      '|---|---|---|---|---|',
      '| 1 | Нужен ли еще один кеш? | нет | нет | ничего |',
    ].join('\n');
    // Модель переписала ответ своим текстом с «е» вместо «ё» задачи — тот же вопрос.
    deepStrictEqual(unaskedQuestions(withYo, report), []);
  });
});

describe('renderAnswerRow / appendAnswerRows', () => {
  const REPORT = [
    '# Вопросы и ответы: демо',
    '',
    '## Вопросы и ответы',
    '_легенда_',
    '',
    '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
    '|---|---|---|---|---|',
    '| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› / (пропущено) | ‹что поправлено› |',
    '',
    '## Уточнённое требование и подход',
    'текст',
  ].join('\n');

  it('отвеченный вопрос рендерится строкой с ответом', () => {
    const row = renderAnswerRow(1, { question: 'Ставка >300см?', blocking: true, source: 'intent' }, '90%');
    strictEqual(row, '| 1 | Ставка >300см? | да | 90% | ‹что изменилось в задаче› |');
  });

  it('пропущенный вопрос (answer=null) рендерится «(пропущено)»', () => {
    const row = renderAnswerRow(2, { question: 'Нужен ли кеш?', blocking: false, source: 'exploration' }, null);
    strictEqual(row, '| 2 | Нужен ли кеш? | нет | (пропущено) | ‹что изменилось в задаче› |');
  });

  it('вертикальная черта в вопросе/ответе экранируется — таблица не рвётся', () => {
    const row = renderAnswerRow(1, { question: 'A|B?', blocking: true, source: 'intent' }, 'x|y');
    strictEqual(row, '| 1 | A\\|B? | да | x\\|y | ‹что изменилось в задаче› |');
  });

  it('дописывает строки, заменяя строку-образец, соседние секции не трогает', () => {
    const row = renderAnswerRow(1, { question: 'Ставка >300см?', blocking: true, source: 'intent' }, '90%');
    const updated = appendAnswerRows(REPORT, [row]);
    ok(!updated.includes('‹вопрос›'), updated);
    ok(updated.includes('| 1 | Ставка >300см? | да | 90% | ‹что изменилось в задаче› |'), updated);
    ok(updated.includes('## Уточнённое требование и подход'), updated);
  });

  it('второй вызов ДОПИСЫВАЕТ, не стирает первую настоящую строку', () => {
    const first = appendAnswerRows(REPORT, [renderAnswerRow(1, { question: 'A?', blocking: true, source: 'intent' }, 'да')]);
    const second = appendAnswerRows(first, [renderAnswerRow(2, { question: 'B?', blocking: false, source: 'exploration' }, null)]);
    ok(second.includes('| 1 | A? | да | да |'), second);
    ok(second.includes('| 2 | B? | нет | (пропущено) |'), second);
  });

  it('пустой список строк — no-op', () => {
    strictEqual(appendAnswerRows(REPORT, []), REPORT);
  });

  it('секции «Вопросы и ответы» нет — no-op, не падение', () => {
    const noSection = '# Отчёт\nбез секции\n';
    strictEqual(appendAnswerRows(noSection, ['| 1 | x | да | y | z |']), noSection);
  });




});
