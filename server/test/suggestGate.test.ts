/**
 * Подсказка строки набора по проскочившему дефекту.
 *
 * Главное — предложение обязано проходить собственный разбор рантайма. Строка, которую
 * `parseGates` не понимает, попав в артефакт, превращает набор гейтов в мусор, а
 * `configProblems` потом назовёт её молчаливо отключённой.
 */

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configProblems, parseGates } from '../src/gates/gatesFile.ts';
import { suggestCheckRow, suggestDebtRow } from '../src/gates/suggestGate.ts';

// Заголовок «## Набор» обязателен: разбор ищет таблицу по нему, а не по первой попавшейся.
const TEXT = [
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да | этап 6 | встроенная проверка рантайма |',
  '| Тесты | да | этап 6 | встроенная проверка рантайма |',
  '',
].join('\n');

const gates = parseGates(TEXT);

describe('подсказка строки проверки', () => {
  it('для встроенной реализации команда не требуется', () => {
    const s = suggestCheckRow(gates, TEXT, 'Секреты в diff', null);
    ok(s !== null);
    strictEqual(s.builtin, true);
    match(s.row, /\| Секреты в diff \| да \| этап 6 \|/);
  });

  it('для внешней проверки команда обязательна', () => {
    strictEqual(suggestCheckRow(gates, TEXT, 'Мой особый гейт', null), null);
    const s = suggestCheckRow(gates, TEXT, 'Мой особый гейт', 'npm run check:custom');
    ok(s !== null);
    match(s.row, /`npm run check:custom`/);
    strictEqual(s.builtin, false);
  });

  it('занятое имя не предлагается: две строки с одним именем — дефект набора', () => {
    strictEqual(suggestCheckRow(gates, TEXT, 'Сборка', null), null);
    // Сравнение через gateKey: регистр и лишние пробелы имя не меняют.
    strictEqual(suggestCheckRow(gates, TEXT, '  сборка ', null), null);
  });

  it('предложенная строка разбирается собственным парсером и не портит набор', () => {
    const s = suggestCheckRow(gates, TEXT, 'Мой гейт', 'true');
    ok(s !== null);
    const after = parseGates(`${TEXT}${s.row}\n`);
    strictEqual(after.rows.length, gates.rows.length + 1);
    strictEqual(configProblems(after).length, configProblems(gates).length);
  });

  it('пустое имя не предлагается', () => {
    strictEqual(suggestCheckRow(gates, TEXT, '   ', 'true'), null);
  });
});

describe('строка принятого риска', () => {
  it('содержит имя и дату: подпись без имени — незаполненный артефакт', () => {
    const row = suggestDebtRow('гейт на этот класс не заведён', 'Гриц', '2026-08-19');
    ok(row !== null);
    ok(row.includes('риск принят'));
    ok(row.includes('Гриц') && row.includes('2026-08-19'));
  });

  it('без имени или даты строка не собирается', () => {
    strictEqual(suggestDebtRow('что-то', '', '2026-08-19'), null);
    strictEqual(suggestDebtRow('что-то', 'Гриц', ''), null);
  });
});
