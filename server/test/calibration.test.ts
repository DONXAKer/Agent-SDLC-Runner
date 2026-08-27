/**
 * Калибровка гейтов посевом.
 *
 * Планка строгости та же, что у остального разбора набора: непонятое значение — это «не
 * калиброван», а не «калиброван». Гейт, чью способность ловить никто не подтверждал, не
 * должен выглядеть подтверждённым из-за опечатки в ячейке.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGates, uncalibratedGates } from '../src/gates/gatesFile.ts';

const text = (calibration: string[]): string =>
  [
    '## Набор',
    '',
    '| Гейт | Вкл | Где отчитывается | Чем реализован |',
    '|---|---|---|---|',
    '| Сборка | да | этап 6 | встроенная |',
    '| Тесты | да | этап 6 | встроенная |',
    '',
    '## Калибровка',
    '',
    '| Гейт | Дата | Класс дефекта | Исход |',
    '|---|---|---|---|',
    ...calibration,
    '',
  ].join('\n');

describe('разбор таблицы калибровки', () => {
  it('«поймал» читается как подтверждение', () => {
    const g = parseGates(text(['| Сборка | 2026-08-19 | сломанный импорт | поймал |']));
    strictEqual(g.calibration[0]?.caught, true);
    strictEqual(uncalibratedGates(g).join(','), 'Тесты');
  });

  it('«не поймал» читается как непойманный посев', () => {
    const g = parseGates(text(['| Сборка | 2026-08-19 | сломанный импорт | не поймал |']));
    strictEqual(g.calibration[0]?.caught, false);
    // Непойманный посев подтверждением не является: гейт остаётся некалиброванным.
    strictEqual(uncalibratedGates(g).includes('Сборка'), true);
  });

  it('непонятое значение — «не калиброван», а не «калиброван»', () => {
    const g = parseGates(text(['| Сборка | 2026-08-19 | x | наверное |']));
    strictEqual(g.calibration[0]?.caught, null);
    strictEqual(uncalibratedGates(g).includes('Сборка'), true);
  });

  it('плейсхолдер в исходе тоже не подтверждение', () => {
    const g = parseGates(text(['| Сборка | ‹дата› | ‹класс› | ‹исход› |']));
    strictEqual(g.calibration[0]?.caught, null);
  });

  it('имя гейта сопоставляется через gateKey', () => {
    const g = parseGates(text(['| `сборка ` | 2026-08-19 | x | да |']));
    strictEqual(uncalibratedGates(g).includes('Сборка'), false);
  });

  it('без таблицы калибровки все включённые гейты некалиброваны', () => {
    const g = parseGates(text([]));
    strictEqual(g.calibration.length, 0);
    strictEqual(uncalibratedGates(g).length, 2);
  });
});
