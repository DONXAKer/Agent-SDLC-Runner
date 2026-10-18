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
import { gatesForStep, pickStepFailure, plannedDependencyBlocker, plannedSameFileFollowup, plannedTestFollowup } from '../src/run/Run.ts';

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

describe('plannedDependencyBlocker', () => {
  const failure = (problem: string): StepCheck => ({ status: 'failed', problem });
  it('откладывает только реальную ошибку импорта из файла, который создаст следующий шаг', () => {
    const problem = "Cannot find module 'file:///ws/src/lines.ts' imported from 'file:///ws/src/vat.ts'\nERR_MODULE_NOT_FOUND";
    deepStrictEqual(plannedDependencyBlocker([failure(problem)], 'src/vat.ts', ['src/lines.ts']), 'src/lines.ts');
  });
  it('не маскирует собственную ошибку файла, несвязанную ошибку или отсутствие будущего шага', () => {
    deepStrictEqual(plannedDependencyBlocker([failure("Cannot find module './missing.ts' imported from './src/vat.ts'")], 'src/vat.ts', ['src/lines.ts']), null);
    deepStrictEqual(plannedDependencyBlocker([failure("Cannot find module './lines.ts' imported from './src/other.ts'")], 'src/vat.ts', ['src/lines.ts']), null);
    deepStrictEqual(plannedDependencyBlocker([failure("Cannot find module './lines.ts' imported from './src/vat.ts'")], 'src/vat.ts', []), null);
  });
});

describe('plannedSameFileFollowup', () => {
  const failure = (problem: string): StepCheck => ({ status: 'failed', problem });
  it('откладывает красные тесты только до следующего шага того же файла', () => {
    deepStrictEqual(plannedSameFileFollowup([failure('гейт «Тесты» (node --test): file:///ws/src/store.ts:8 assertion failed')], 'src/store.ts', ['src/store.ts']), true);
    deepStrictEqual(plannedSameFileFollowup([failure('гейт «Сборка»: src/store.ts syntax error')], 'src/store.ts', ['src/store.ts']), false);
    deepStrictEqual(plannedSameFileFollowup([failure('гейт «Тесты»: src/store.ts failed')], 'src/store.ts', []), false);
    deepStrictEqual(plannedSameFileFollowup([failure('гейт «Тесты»: src/other.ts failed')], 'src/store.ts', ['src/store.ts']), false);
  });
});

describe('plannedTestFollowup', () => {
  const failure = (problem: string): StepCheck => ({ status: 'failed', problem });
  it('откладывает только красный тест со стеком в файле следующего шага', () => {
    deepStrictEqual(plannedTestFollowup([failure('гейт «Тесты» (node --test): ReferenceError at src/index.ts:35')], 'src/invoice.ts', ['src/index.ts']), 'src/index.ts');
    deepStrictEqual(plannedTestFollowup([failure('гейт «Тесты» (node --test): AssertionError at test/store.test.ts:35')], 'src/store.ts', ['src/store.ts']), null);
    deepStrictEqual(plannedTestFollowup([failure('гейт «Сборка»: SyntaxError at src/index.ts:35')], 'src/invoice.ts', ['src/index.ts']), null);
    deepStrictEqual(plannedTestFollowup([failure('гейт «Тесты»: ReferenceError at src/index.ts:35')], 'src/invoice.ts', []), null);
  });
});
