/**
 * Шаги плана (`artifacts/planSteps.ts`): явная форма `### Шаг N` и fallback по
 * `files_to_touch`. Пути fallback'а обязаны совпадать с тем, что видит политика.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFilesToTouch } from '../src/artifacts/planFiles.ts';
import { describeStep, extractExplicitSteps, planSteps, stepsFromFilesToTouch } from '../src/artifacts/planSteps.ts';

const EXPLICIT = [
  '# План',
  '',
  '## Шаги',
  '',
  '### Шаг 1 — Добавить `surchargeFor` в новый модуль',
  '- файл: `src/oversize.ts` (новый)',
  '- символ: surchargeFor (новый)',
  '- действие: экспортировать функцию надбавки по порогам плана',
  '- закрывает: claim-2, claim-4',
  '- проверка: `node --test test/oversize.test.ts` · ожидаемо: зелёный',
  '- факты человека: ставка за сумму измерений — 90 %',
  '',
  '### Шаг 2: Использовать `surchargeFor` в `priceFor`',
  '- **файл:** src/tariffs.ts',
  '- **символ:** priceFor',
  '- **действие:** прибавить надбавку к базовой цене',
  '- **закрывает:** claim-1',
  '',
  '### Шаг 3 — шаг без файла',
  '- действие: ничего исполнимого',
  '',
  '## files_to_touch',
  '',
  '| Путь | Что делаем |',
  '|---|---|',
  '| `src/oversize.ts` | новый модуль |',
  '| `src/tariffs.ts` | правка priceFor |',
  '',
].join('\n');

const OLD_FORM = [
  '# План',
  '',
  '## Шаги',
  '1. Добавить модуль надбавки.',
  '2. Использовать его в `priceFor`.',
  '',
  '## files_to_touch',
  '',
  '| Путь | Что делаем |',
  '|---|---|',
  '| `src/oversize.ts` | Файл отсутствует — создать модуль надбавки (claim-2) |',
  '| `src/tariffs.ts` | Вызвать надбавку из `priceFor` |',
  '| `test/oversize.test.ts` | новые тесты |',
  '',
  'Из задачи исключено: `src/index.ts`.',
  '',
].join('\n');

describe('явная форма шага плана', () => {
  it('читает файл, символ, действие, пункты, проверку и факты; шаг без файла пропускает', () => {
    const steps = extractExplicitSteps(EXPLICIT);
    strictEqual(steps.length, 2);
    const s1 = steps[0]!;
    strictEqual(s1.n, 1);
    strictEqual(s1.file, 'src/oversize.ts');
    strictEqual(s1.isNew, true);
    strictEqual(s1.symbol, 'surchargeFor');
    deepStrictEqual(s1.claims, ['claim-2', 'claim-4']);
    strictEqual(s1.check, 'node --test test/oversize.test.ts');
    strictEqual(s1.expect, 'зелёный');
    ok(s1.facts?.includes('90 %'));
    strictEqual(s1.explicit, true);

    const s2 = steps[1]!;
    strictEqual(s2.file, 'src/tariffs.ts');
    strictEqual(s2.isNew, false);
    strictEqual(s2.symbol, 'priceFor');
    strictEqual(s2.action, 'прибавить надбавку к базовой цене');
    deepStrictEqual(s2.claims, ['claim-1']);
    strictEqual(s2.check, null);
  });

  it('planSteps предпочитает явную форму, когда она есть', () => {
    strictEqual(planSteps(EXPLICIT).every((s) => s.explicit), true);
  });
});

describe('fallback по files_to_touch', () => {
  it('даёт по шагу на путь, теми же путями, что видит политика', () => {
    const steps = stepsFromFilesToTouch(OLD_FORM);
    deepStrictEqual(
      steps.map((s) => s.file),
      extractFilesToTouch(OLD_FORM),
    );
    strictEqual(steps.length, 3);
    strictEqual(steps[0]!.isNew, true);
    ok(steps[0]!.action.includes('создать модуль'));
    deepStrictEqual(steps[0]!.claims, ['claim-2']);
    strictEqual(steps[1]!.isNew, false);
    strictEqual(steps[2]!.isNew, true);
    strictEqual(steps[0]!.explicit, false);
  });

  it('«добавить новые кейсы» существующий файл новым не делает; пометка про файл — делает', () => {
    const plan = [
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `test/tariffs.test.ts` | добавить новые кейсы на порог |',
      '| `src/oversize.ts` | новый модуль надбавки |',
      '| `src/limits.ts` | файл будет создан |',
    ].join('\n');
    deepStrictEqual(
      stepsFromFilesToTouch(plan).map((s) => s.isNew),
      [false, true, true],
    );
  });

  it('путь явного шага очищается от хвостовых разделителей и кавычек', () => {
    const plan = ['### Шаг 1 — два файла в одном', '- файл: `src/a.ts`, `src/b.ts`', '- действие: x'].join('\n');
    strictEqual(extractExplicitSteps(plan)[0]!.file, 'src/a.ts');
  });

  it('исключённый путь шагом не становится', () => {
    ok(!planSteps(OLD_FORM).some((s) => s.file === 'src/index.ts'));
  });

  it('план без files_to_touch даёт пустой список, а не исключение', () => {
    deepStrictEqual(planSteps('# План\n\nничего'), []);
  });

  it('describeStep называет файл, символ и пункты', () => {
    const line = describeStep(planSteps(EXPLICIT)[0]!);
    ok(line.includes('src/oversize.ts (новый)'));
    ok(line.includes('символ surchargeFor'));
    ok(line.includes('claim-2'));
  });
});
