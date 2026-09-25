/**
 * Выбор гейтов для проверки после шага этапа 5 по шагам (`stepFill`, без tool-use).
 *
 * «Сборка» и «Тесты» — ОБЕ безусловно, если включены, независимо от того, тестовый ли
 * файл у шага. Раньше «Тесты» подключалась только к тестовым шагам — живой замер поймал
 * дыру: шаг продуктового кода ломает свой же файл (забытый импорт, `ReferenceError`
 * только в рантайме — «Сборка» такое не ловит), а красный «Тесты» всплывает только на
 * следующем тестовом шаге, чинить уже нечем (docs/model-runs.md, `ministral3-14b-
 * reasoning-stepfill` / `lmstudio:qwen3-8b-stepfill`, идентичные 14/10/4). Опасение
 * «ложный красный на промежуточном состоянии» закрывает `mentionsFile()` в
 * `StepExecutor.ts`, не сужение набора здесь. Сигнатура больше не принимает файл шага —
 * решение больше от него не зависит.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StepCheck } from '../src/exec/StepExecutor.ts';
import { parseGates } from '../src/gates/gatesFile.ts';
import { gatesForStep, pickStepFailure } from '../src/run/Run.ts';

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

const WITH_IMPORTS = [
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да | этап 6 | встроенная проверка рантайма |',
  '| Тесты | да | этап 6 | встроенная проверка рантайма |',
  '| Импорты | да | этап 6 | встроенная проверка рантайма |',
  '',
].join('\n');

describe('gatesForStep', () => {
  it('обе строки включены — оба гейта, «Сборка» первой', () => {
    const rows = gatesForStep(parseGates(BOTH_ENABLED));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка', 'Тесты'],
    );
  });

  // «Импорты» — не в MINIMUM: подключается только если проект сам завёл строку в
  // .sdlc/gates.md, раннер не навязывает языковую проверку всем целевым проектам.
  it('«Импорты» включена в наборе — все три гейта, «Импорты» последней', () => {
    const rows = gatesForStep(parseGates(WITH_IMPORTS));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка', 'Тесты', 'Импорты'],
    );
  });

  it('«Импорты» нет в наборе проекта — не попадает в список', () => {
    const rows = gatesForStep(parseGates(BOTH_ENABLED));
    deepStrictEqual(
      rows.map((r) => r.name).includes('Импорты'),
      false,
    );
  });

  it('«Тесты» выключена в наборе — только «Сборка»', () => {
    const rows = gatesForStep(parseGates(ONLY_BUILD));
    deepStrictEqual(
      rows.map((r) => r.name),
      ['Сборка'],
    );
  });

  it('набора гейтов нет вовсе (null) — пустой список', () => {
    deepStrictEqual(gatesForStep(null), []);
  });
});

describe('pickStepFailure', () => {
  const failure = (problem: string): StepCheck => ({ status: 'failed', problem });

  it('пустой список — гейты пройдены (null)', () => {
    deepStrictEqual(pickStepFailure([], 'test/vat.test.ts'), null);
  });

  it('своя строка красная последней — всё равно побеждает над чужой первой', () => {
    // 2026-09-25 (`d2-devstral-vat-rounding`): «Сборка» краснела по чужой причине первой
    // и не давала «Тестам» даже запуститься — эта функция и есть противоядие: она решает
    // ПОСЛЕ того, как прогнаны все строки, а не по первой попавшейся.
    const own = failure("file:///ws/test/vat.test.ts:4\nSyntaxError: does not provide an export named 'Line'");
    const foreign = failure('src/other.ts(3,1): нет экспорта');
    deepStrictEqual(pickStepFailure([foreign, own], 'test/vat.test.ts'), own);
  });

  it('ни одна строка не про файл шага — первая красная как раньше (StepExecutor пометит «вне этого файла»)', () => {
    const a = failure('src/other.ts(3,1): нет экспорта');
    const b = failure('src/third.ts(1,1): нет экспорта');
    deepStrictEqual(pickStepFailure([a, b], 'test/vat.test.ts'), a);
  });
});
