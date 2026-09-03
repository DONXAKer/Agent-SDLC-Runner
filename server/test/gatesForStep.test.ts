/**
 * Выбор гейтов для проверки после шага этапа 5 по шагам (`stepFill`, без tool-use).
 *
 * «Сборка» — всегда, «Тесты» — дополнительно, и только для шага с тестовым файлом.
 * Разбор трёх реальных прогонов (docs/model-runs.md) показал: без второго гейта
 * поломка собственного теста модели (потерянный дефолт хелпера, TDZ-затенение,
 * неверные ожидаемые числа) видна только на прогоне всего chunk'а целиком.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGates } from '../src/gates/gatesFile.ts';
import { gatesForStep } from '../src/run/Run.ts';

const BOTH_ENABLED = [
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да | этап 6 | встроенная проверка рантайма |',
  '| Тесты | да | этап 6 | встроенная проверка рантайма |',
  '',
].join('\n');

const ONLY_BUILD = [
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да | этап 6 | встроенная проверка рантайма |',
  '| Тесты | нет | этап 6 | встроенная проверка рантайма |',
  '',
].join('\n');

describe('gatesForStep', () => {
  it('шаг не тестовый — только «Сборка», даже если «Тесты» включена', () => {
    const rows = gatesForStep('src/oversize.ts', parseGates(BOTH_ENABLED));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка'],
    );
  });

  it('шаг тестовый при включённой «Тесты» — оба гейта, «Сборка» первой', () => {
    const rows = gatesForStep('test/oversize.test.ts', parseGates(BOTH_ENABLED));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка', 'Тесты'],
    );
  });

  it('шаг тестовый, но «Тесты» выключена в наборе — только «Сборка», как раньше', () => {
    const rows = gatesForStep('test/oversize.test.ts', parseGates(ONLY_BUILD));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка'],
    );
  });

  it('набора гейтов нет вовсе (null) — пустой список', () => {
    deepStrictEqual(gatesForStep('test/oversize.test.ts', null), []);
  });
});
