/**
 * Шаги плана (`artifacts/planSteps.ts`): явная форма `### Шаг N` и fallback по
 * `files_to_touch`. Пути fallback'а обязаны совпадать с тем, что видит политика.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractFilesToTouch } from '../src/artifacts/planFiles.ts';
import { appendMissingPlanStepCards, describeStep, explicitStepProblems, extractExplicitSteps, planSteps, stepsFromFilesToTouch } from '../src/artifacts/planSteps.ts';

it('сохраняет продолжения действия, проверки и фактов человека', () => {
  const [step] = extractExplicitSteps('### Шаг 1 — НДС\n- файл: src/vat.ts\n- действие: ставка 10% если все reduced, иначе\n  20%; поле vat не добавлять\n  при none\n- проверка: `node --test test/vat.test.ts` · ожидаемо:\n  зелёный\n- факты человека: расчёт от суммы\n  с округлением половина вверх\n');
  strictEqual(step?.action, 'ставка 10% если все reduced, иначе 20%; поле vat не добавлять при none');
  strictEqual(step?.expect, 'зелёный');
  strictEqual(step?.facts, 'расчёт от суммы с округлением половина вверх');
});

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
  '- контракт: новый экспорт `surchargeFor(input) → amount`; см. вызывающие в таблице плана',
  '- зависит от: нет',
  '- факты человека: ставка за сумму измерений — 90 %',
  '',
  '### Шаг 2: Использовать `surchargeFor` в `priceFor`',
  '- **файл:** src/tariffs.ts',
  '- **символ:** priceFor',
  '- **действие:** прибавить надбавку к базовой цене',
  '- **закрывает:** claim-1',
  '- проверка: `node --test test/tariffs.test.ts` · ожидаемо: зелёный',
  '- контракт: н/п — сигнатура `priceFor` не меняется',
  '- зависит от: шаг 1',
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
  it('отделяет имя символа от запятой и принимает явное отсутствие символа у документа', () => {
    strictEqual(extractExplicitSteps(EXPLICIT.replace('- **символ:** priceFor', '- **символ:** priceFor, меняется тело'))[1]?.symbol, 'priceFor');
    strictEqual(extractExplicitSteps(EXPLICIT.replace('- **символ:** priceFor', '- **символ:** н/п — документация'))[1]?.symbol, null);
  });
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
    strictEqual(s1.contractChange, 'новый экспорт `surchargeFor(input) → amount`; см. вызывающие в таблице плана');
    deepStrictEqual(s1.dependsOn, []);
    ok(s1.facts?.includes('90 %'));
    strictEqual(s1.explicit, true);

    const s2 = steps[1]!;
    strictEqual(s2.file, 'src/tariffs.ts');
    strictEqual(s2.isNew, false);
    strictEqual(s2.symbol, 'priceFor');
    strictEqual(s2.action, 'прибавить надбавку к базовой цене');
    deepStrictEqual(s2.claims, ['claim-1']);
    strictEqual(s2.check, 'node --test test/tariffs.test.ts');
    strictEqual(s2.checkSpecified, true);
    deepStrictEqual(s2.dependsOn, [1]);
  });

  it('проверяет полноту карточек и порядок зависимостей', () => {
    const valid = EXPLICIT.replace('### Шаг 3 — шаг без файла\n- действие: ничего исполнимого\n', '');
    deepStrictEqual(explicitStepProblems(valid), []);
    const invalid = valid.replace('- зависит от: шаг 1', '- зависит от: шаг 3');
    ok(explicitStepProblems(invalid).some((p) => p.includes('более ранний шаг')));
    ok(explicitStepProblems(valid.replace('- контракт: н/п — сигнатура `priceFor` не меняется\n', ''))
      .some((p) => p.includes('контракт')));
  });

  it('requires an implementation step for every files_to_touch entry', () => {
    const malformed = EXPLICIT.replace('- **файл:** src/tariffs.ts', '- **файл:** src/oversize.ts');
    ok(explicitStepProblems(malformed).some((problem) => problem.includes('src/tariffs.ts')));
  });

  it('rejects several target files packed into one step card', () => {
    const malformed = EXPLICIT.replace(
      '- файл: `src/oversize.ts` (новый)',
      '- файл: `src/oversize.ts` (экспорт в `src/index.ts`, новый)',
    );
    ok(explicitStepProblems(malformed).some((problem) => problem.includes('ровно один файл на карточку')));
  });

  it('rejects duplicate step cards for the same file', () => {
    const malformed = EXPLICIT.replace(
      '## files_to_touch',
      [
        '### Шаг 3 — Проверить модуль',
        '- файл: src/oversize.ts (новый)',
        '- символ: тест',
        '- действие: добавить поведенческий тест',
        '- закрывает: claim-2',
        '- проверка: `node --test test/oversize.test.ts` · ожидаемо: зелёный',
        '- контракт: н/п — тест',
        '- зависит от: шаг 1',
        '',
        '## files_to_touch',
      ].join('\n'),
    );
    ok(explicitStepProblems(malformed).some((problem) => problem.includes('уже покрыт другой карточкой')));
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

describe('карточки на все разрешённые файлы', () => {
  it('добавляет заготовку только для пути без явного шага и сохраняет уже заполненные шаги', () => {
    const plan = [
      '## Шаги',
      '### Шаг 1 — Обновить модуль',
      '- файл: src/a.ts (существующий)',
      '- символ: run',
      '- действие: обновить run',
      '- закрывает: claim-1',
      '- проверка: н/п — проверяется шагом тестов',
      '- контракт: н/п — сигнатура без изменений',
      '- зависит от: нет',
      '- факты человека: н/п',
      '',
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| src/a.ts | обновить run |',
      '| src/index.ts | экспортировать run |',
      '| test/new.test.ts | новый файл тестов |',
    ].join('\n');
    const result = appendMissingPlanStepCards(plan);
    deepStrictEqual(result.paths, ['src/index.ts', 'test/new.test.ts']);
    ok(result.text.includes('### Шаг 2 — Изменить src/index.ts'));
    ok(result.text.includes('- файл: src/index.ts (существующий)'));
    ok(result.text.includes('### Шаг 3 — Создать test/new.test.ts'));
    ok(result.text.includes('- файл: test/new.test.ts (новый)'));
    strictEqual(result.text.includes('### Шаг 1 — Обновить модуль'), true);
  });

  it('ничего не добавляет без секции шагов или когда все файлы покрыты', () => {
    const noSteps = appendMissingPlanStepCards('## files_to_touch\n| Путь |\n|---|\n| src/a.ts |');
    strictEqual(noSteps.text.includes('Шаг 1'), false);
    deepStrictEqual(noSteps.paths, []);
  });
});
