/**
 * `md/table.ts::splitRow` — теперь общий с вебом (`@sdlc-runner/shared`, code-review-all
 * 2026-09-26). Регрессия: `|` внутри `` `команды` `` резал ячейку колонки «Чем реализован»
 * набора гейтов пополам — та колонка пишется человеком напрямую (не через `escapeCell`), и
 * шелл-команда с пайпом (`npm test | tail -20`) там реалистична.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitRow } from '../src/md/table.ts';
import { parseGates } from '../src/gates/gatesFile.ts';

describe('splitRow: `|` внутри обратных кавычек — не разделитель', () => {
  it('команда с пайпом остаётся одной ячейкой', () => {
    deepStrictEqual(splitRow('| Тесты | `npm test | tail -20` | этап 6 |'), ['Тесты', '`npm test | tail -20`', 'этап 6']);
  });

  it('экранированная черта вне кода по-прежнему литерал', () => {
    deepStrictEqual(splitRow('| a \\| b | `x | y` | c |'), ['a | b', '`x | y`', 'c']);
  });

  it('без обратных кавычек — поведение прежнее', () => {
    deepStrictEqual(splitRow('| Сборка | да | этап 6 |'), ['Сборка', 'да', 'этап 6']);
  });
});

describe('parseGates: гейт с пайпом в команде разбирается одной колонкой, не режется', () => {
  it('колонка «Чем реализован» с `npm test | tail -20` не рвёт таблицу набора', () => {
    const text = [
      '## Набор',
      '',
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Тесты | да — минимум | этап 6 | `npm test 2>&1 | tail -20` |',
      '',
    ].join('\n');
    const g = parseGates(text);
    strictEqual(g.rows.length, 1);
    strictEqual(g.rows[0]!.name, 'Тесты');
    strictEqual(g.rows[0]!.command, 'npm test 2>&1 | tail -20');
  });
});
