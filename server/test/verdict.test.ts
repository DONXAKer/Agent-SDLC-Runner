/**
 * Таблица вердикта — семь строк статусов и семь условий вне статусов. Проверяются все
 * четырнадцать: вердикт это единственное место, где «сделано» превращается в решение,
 * и пропущенная строка здесь стоит ложного зелёного на живом витке.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VerdictInput } from '@sdlc-runner/shared';

import { collectVerdictInput, readReport } from '../src/verdict/collect.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';
import { minimumProblems, openDebt, parseGates } from '../src/gates/gatesFile.ts';

/** Зелёный вход: всё прошло, ничего не сломано, попытка первая из трёх. */
function green(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    gates: [{ name: 'Сборка', status: '✅', inapplicableSignedBy: null }],
    claims: [{ id: 'claim-1', status: '✅' }],
    confirmedReviewFindings: 0,
    enabledGatesMissingFromReport: [],
    openDebtRows: [],
    brokenInvariants: [],
    regressions: [],
    plannedPathsUntouched: [],
    diffMatchesTree: true,
    attempt: 1,
    attemptBudget: 3,
    noProgress: false,
    ...over,
  };
}

describe('вердикт: статусы', () => {
  it('всё зелёное — passed и продолжение', () => {
    const v = computeVerdict(green());
    strictEqual(v.passed, true);
    strictEqual(v.action, 'continue');
    deepStrictEqual(v.reasons, []);
  });

  it('провалившийся гейт роняет вердикт', () => {
    const v = computeVerdict(
      green({ gates: [{ name: 'Тесты', status: '❌', inapplicableSignedBy: null }] }),
    );
    strictEqual(v.passed, false);
    ok(v.reasons.some((r) => r.includes('Тесты')), v.reasons.join('; '));
  });

  it('гейт «включён, но не запускался» роняет вердикт без подписанной неприменимости', () => {
    const v = computeVerdict(
      green({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: null }] }),
    );
    strictEqual(v.passed, false);
  });

  it('подписанная человеком неприменимость снимает ⏭ — и только она', () => {
    ok(
      computeVerdict(green({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: 'Иван' }] }))
        .passed,
    );
    // Пустая подпись — это не подпись: колонка «Утвердил» без имени = артефакт не заполнен.
    ok(
      !computeVerdict(green({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: '  ' }] }))
        .passed,
    );
  });

  it('гейта нет в наборе — статуса он не получает и вердикт не роняет', () => {
    // Отсутствующий гейт просто не попадает в список: он в долге, и его судьба — там.
    ok(computeVerdict(green({ gates: [] })).passed);
  });

  it('опровергнутый пункт приёмки роняет вердикт', () => {
    ok(!computeVerdict(green({ claims: [{ id: 'claim-2', status: '❌' }] })).passed);
  });

  it('непроверяемый пункт (⚠) роняет вердикт — это не «почти да»', () => {
    const v = computeVerdict(green({ claims: [{ id: 'claim-3', status: '⚠' }] }));
    strictEqual(v.passed, false);
    ok(v.reasons.some((r) => r.includes('claim-3')));
  });

  it('приоритетов у пунктов нет: любой ❌ роняет вердикт', () => {
    const v = computeVerdict(
      green({
        claims: [
          { id: 'claim-1', status: '✅' },
          { id: 'claim-2', status: '✅' },
          { id: 'claim-9', status: '❌' },
        ],
      }),
    );
    strictEqual(v.passed, false);
  });
});

describe('вердикт: семь условий вне статусов', () => {
  const cases: [string, Partial<VerdictInput>, RegExp][] = [
    ['подтверждённое расхождение из ревью', { confirmedReviewFindings: 1 }, /ревью/i],
    ['включённый гейт без строки в отчёте', { enabledGatesMissingFromReport: ['Тесты'] }, /отчёт/i],
    ['незакрытая строка долга', { openDebtRows: ['Секреты в diff (нет даты)'] }, /долг/i],
    ['нарушенный инвариант', { brokenInvariants: ['порядок вызовов'] }, /инвариант/i],
    ['регрессия', { regressions: ['логин перестал работать'] }, /регресс/i],
    ['путь плана «не сделано»', { plannedPathsUntouched: ['src/a.ts'] }, /не сделано/i],
    ['diff не совпал с деревом', { diffMatchesTree: false }, /не совпал/i],
  ];

  for (const [name, patch, why] of cases) {
    it(`${name} роняет вердикт сам по себе`, () => {
      const v = computeVerdict(green(patch));
      strictEqual(v.passed, false, `${name}: вердикт обязан быть красным`);
      ok(v.reasons.some((r) => why.test(r)), v.reasons.join('; '));
    });
  }

  it('расхождение ревью роняет вердикт даже при всех зелёных гейтах и пунктах', () => {
    const v = computeVerdict(green({ confirmedReviewFindings: 2 }));
    strictEqual(v.passed, false);
  });
});

describe('вердикт: действие', () => {
  it('красный вердикт в пределах бюджета — возврат на доработку', () => {
    strictEqual(computeVerdict(green({ regressions: ['x'], attempt: 1 })).action, 'retry');
  });

  it('исчерпанный бюджет — эскалация, а не ещё одна попытка', () => {
    const v = computeVerdict(green({ regressions: ['x'], attempt: 3, attemptBudget: 3 }));
    strictEqual(v.action, 'escalate');
    ok(v.reasons.some((r) => /бюджет/i.test(r)));
  });

  it('отсутствие прогресса — эскалация даже при остатке бюджета', () => {
    const v = computeVerdict(green({ regressions: ['x'], attempt: 2, noProgress: true }));
    strictEqual(v.action, 'escalate');
  });

  it('зелёный вердикт не эскалируется даже на последней попытке', () => {
    strictEqual(computeVerdict(green({ attempt: 3, attemptBudget: 3 })).action, 'continue');
  });
});

// ---------------------------------------------------------------------------

const REPORT = `# Отчёт приёмки: demo, chunk 1, попытка 1

- **Сверка с деревом:** перегенерированный \`git diff\` совпал с патчем: да
- **Долг набора:** все строки закрыты

## Гейты

| Гейт | Статус | Результат |
|---|---|---|
| Сборка | ✅ | npm run build · 0 |
| Тесты | ⏭ | раннер не найден |
| Ревью независимым агентом | ✅ | sonnet |

| Гейт | Почему бессмыслен для этого diff'а | Утвердил (человек) |
|---|---|---|
| Тесты | правка только документации | Иван |

## 1. Пункты приёмки

| id | Пункт | passed | Чем подтверждён | Что чинить |
|---|---|---|---|---|
| claim-1 | пользователь видит… | ✅ | Foo.java:bar | н/п |
| claim-2 | ошибка показывается… | ⚠ | тест не прогонялся | прогнать тест |

## 2. Ревью: что искали опровергнуть

- Подтверждённое расхождение: н/п
- Поведение, не покрытое ни одним пунктом: н/п

## 3. Scope

- Файлы вне \`plan.files_to_touch\`: нет
- **Пути плана без правок:**
  - \`src/skipped.ts\` — «не сделано»

## 4. Инварианты

- порядок вызовов — держится, чем подтверждён: OrderTest

## 5. Регрессии

- нет
`;

describe('чтение отчёта приёмки', () => {
  const facts = readReport(REPORT);

  it('статусы гейтов читаются по именам набора', () => {
    strictEqual(facts.gateStatuses.get('сборка'), '✅');
    strictEqual(facts.gateStatuses.get('тесты'), '⏭');
  });

  it('таблица неприменимости не путается с таблицей гейтов', () => {
    strictEqual(facts.inapplicable.get('тесты'), 'Иван');
    strictEqual(facts.inapplicable.size, 1);
  });

  it('пункты приёмки читаются со статусами', () => {
    deepStrictEqual(facts.claims, [
      { id: 'claim-1', status: '✅' },
      { id: 'claim-2', status: '⚠' },
    ]);
  });

  it('«не сделано» отличается от «не потребовалось»', () => {
    deepStrictEqual(facts.plannedPathsUntouched, ['src/skipped.ts']);
  });

  it('«н/п» в ревью и «нет» в регрессиях — это пусто, а не находка', () => {
    strictEqual(facts.confirmedReviewFindings, 0);
    deepStrictEqual(facts.regressions, []);
    deepStrictEqual(facts.brokenInvariants, []);
  });

  it('сверка с деревом читается утверждением, а не по умолчанию', () => {
    strictEqual(facts.diffMatchesTree, true);
    strictEqual(readReport('- **Сверка с деревом:** совпал: **нет**').diffMatchesTree, false);
    // Строки нет вовсе — это не «да».
    strictEqual(readReport('# пусто').diffMatchesTree, false);
  });

  it('строка гейта со стёртым статусом читается как ⏭, а не как прошедший', () => {
    const f = readReport('## Гейты\n\n| Гейт | Статус | Результат |\n|---|---|---|\n| Сборка |  | — |\n');
    strictEqual(f.gateStatuses.get('сборка'), '⏭');
  });
});

const GATES = `# Набор гейтов: demo

## Набор

| Гейт | Вкл | Где отчитывается | Чем реализован |
|---|---|---|---|
| Сборка | да — минимум | этап 6 | \`npm run build\` |
| Тесты | да — минимум | этап 6 | \`npm test\` |
| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки diff с files_to_touch |
| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |
| Ревью независимым агентом | да — минимум | этап 6 | агент на более сильной модели |
| Секреты в diff | нет | этап 6 | н/п — долг |
| Проверка предусловий публикации | нет | этап 7 | н/п — долг |
| Калибровка гейтов посевом | нет | вне витка | н/п — долг |

## Долг

| Гейт | Где должен стоять | Как закрывается | Дата | Кто |
|---|---|---|---|---|
| Секреты в diff | этап 6 | риск принят: смотрим глазами | 2026-08-01 | Иван |
| Проверка предусловий публикации | этап 7 | проверяет руками: чек-лист | 2026-08-01 | Иван |
| Калибровка гейтов посевом | вне витка | риск принят: нечем | ‹дата› | Иван |
`;

describe('набор гейтов', () => {
  const g = parseGates(GATES);

  it('минимальная пятёрка распознаётся и её отсутствие останавливает виток', () => {
    deepStrictEqual(minimumProblems(g), []);
    const выключенные = parseGates(GATES.replace('| Тесты | да — минимум', '| Тесты | нет'));
    ok(minimumProblems(выключенные).length > 0, 'выключенный гейт минимума обязан быть замечен');
  });

  it('команда берётся только из обратных кавычек, проза командой не считается', () => {
    strictEqual(g.rows.find((r) => r.name === 'Сборка')?.command, 'npm run build');
    strictEqual(g.rows.find((r) => r.name === 'Scope: файлы вне плана')?.command, null);
  });

  it('строка долга без даты считается незакрытой', () => {
    const open = openDebt(g);
    strictEqual(open.length, 1);
    ok(open[0]!.includes('Калибровка'), open.join('; '));
  });

  it('выключенный гейт вообще без строки долга — тоже незакрытый долг', () => {
    const g2 = parseGates(GATES.replace(/\| Секреты в diff \| этап 6.*\n/, ''));
    ok(openDebt(g2).some((r) => /Секреты в diff/.test(r)));
  });

  it('шапка таблицы гейтом не считается', () => {
    ok(!g.rows.some((r) => r.name.toLowerCase() === 'гейт'));
  });
});

describe('сборка входа вердикта', () => {
  const gates = parseGates(GATES);

  it('гейты «этап 7» и «вне витка» в отчёте не требуются', () => {
    const { input } = collectVerdictInput({
      gates,
      gateResults: [],
      report: REPORT,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    ok(!input.enabledGatesMissingFromReport.some((n) => /публикации|Калибровка/.test(n)));
  });

  it('включённый гейт без строки в отчёте назван поимённо', () => {
    const { input } = collectVerdictInput({
      gates,
      gateResults: [],
      report: REPORT,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    // В отчёте нет строк «Scope: файлы вне плана» и «Анти-обход тест-гейта».
    deepStrictEqual(
      [...input.enabledGatesMissingFromReport].sort(),
      ['Scope: файлы вне плана', 'Анти-обход тест-гейта'].sort(),
    );
  });

  // Регрессия по построению: статус, переписанный рецензентом, не должен подменять
  // фактический код возврата — иначе гейты становятся декорацией при первом же
  // «ну там на самом деле всё хорошо».
  it('при расхождении отчёта и прогона побеждает прогон', () => {
    const { input, disagreements } = collectVerdictInput({
      gates,
      gateResults: [
        { name: 'Сборка', status: '❌', command: 'npm run build', exitCode: 1, lastLine: 'error', durationMs: 5 },
      ],
      report: REPORT,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    strictEqual(input.gates.find((g) => g.name === 'Сборка')?.status, '❌');
    strictEqual(disagreements.length, 1);
    ok(!computeVerdict(input).passed);
  });

  it('незакрытый долг набора доезжает до вердикта', () => {
    const { input } = collectVerdictInput({
      gates,
      gateResults: [],
      report: REPORT,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    ok(input.openDebtRows.some((r) => /Калибровка/.test(r)));
    ok(!computeVerdict(input).passed);
  });
});
