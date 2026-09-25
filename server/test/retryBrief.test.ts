/**
 * Выжимка причин красного для следующей попытки.
 *
 * Проверяется как чистая функция на фиксированном входе — I/O у неё нет по построению.
 * Отдельная планка: в блоке не должно появляться утверждений, которых нет в данных.
 */

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult, VerdictInput } from '@sdlc-runner/shared';

import { buildRetryBrief, claimTextCell } from '../src/verdict/retryBrief.ts';

function input(over: Partial<VerdictInput> = {}): VerdictInput {
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
    attempt: 2,
    attemptBudget: 3,
    noProgress: false,
    ...over,
  };
}

function gate(over: Partial<GateRunResult> = {}): GateRunResult {
  return {
    name: 'Тесты',
    status: '❌',
    command: 'npm test',
    exitCode: 1,
    lastLine: '2 failing',
    durationMs: 1200,
    envBlocked: false,
    ...over,
  };
}

describe('текст пункта приёмки для брифа', () => {
  it('из строки таблицы берётся формулировка, не вся строка с процедурой и статусом', () => {
    // Семь строк по ~600 символов резались потолком карточки шага раньше находок рецензента.
    strictEqual(
      claimTextCell('| claim-2 [edge] | Ровно на границе — не негабарит | Новый тест: `order(...)` | ❌ |'),
      'Ровно на границе — не негабарит',
    );
    strictEqual(claimTextCell('| `claim-1` | Текст пункта | — |'), 'Текст пункта');
    strictEqual(claimTextCell('- claim-3 — надбавка 40% от base'), 'надбавка 40% от base');
    strictEqual(claimTextCell('3. claim-4: сумма > 300 см'), 'сумма > 300 см');
    // Не таблица и не список — строка как есть.
    strictEqual(claimTextCell('claim-5 без разделителя текст'), 'без разделителя текст');
  });
});

describe('выжимка причин для ретрая', () => {
  it('на зелёном входе не собирается вовсе', () => {
    strictEqual(buildRetryBrief(input(), []), null);
  });

  it('называет проваленные пункты приёмки по их id', () => {
    const brief = buildRetryBrief(
      input({ claims: [{ id: 'claim-1', status: '❌' }, { id: 'claim-2', status: '⚠' }] }),
      [],
    );
    ok(brief !== null);
    match(brief, /claim-1 — опровергнут/);
    match(brief, /claim-2 — не проверяем/);
  });

  it('переносит упавший гейт с командой, кодом и последней строкой вывода', () => {
    const brief = buildRetryBrief(input(), [gate()]);
    ok(brief !== null);
    match(brief, /«Тесты»/);
    match(brief, /npm test/);
    match(brief, /код 1/);
    match(brief, /2 failing/);
  });

  it('пустой вывод называет пустым, а не выдумывает причину', () => {
    const brief = buildRetryBrief(input(), [gate({ lastLine: '   ' })]);
    ok(brief !== null);
    match(brief, /вывод пуст/);
  });

  it('зелёные гейты в выжимку не попадают', () => {
    const brief = buildRetryBrief(input({ claims: [{ id: 'c', status: '❌' }] }), [
      gate({ name: 'Сборка', status: '✅', lastLine: 'ok' }),
    ]);
    ok(brief !== null);
    strictEqual(brief.includes('Сборка'), false);
  });

  it('различает пропуск без подписи и штатную неприменимость', () => {
    const unsigned = buildRetryBrief(
      input({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: null }] }),
      [],
    );
    ok(unsigned !== null);
    match(unsigned, /не запускались/);

    const signed = buildRetryBrief(
      input({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: 'Гриц' }] }),
      [],
    );
    strictEqual(signed, null);
  });

  it('retry_instruction рецензента идёт первой строкой после шапки, «н/п» — не идёт', () => {
    const red = input({ claims: [{ id: 'claim-1', status: '❌' }] });
    const brief = buildRetryBrief(red, [], { retryInstruction: 'убрать условие sku !== "" в src/store.ts:35' });
    ok(brief !== null);
    const at = brief.indexOf('Рецензент: в первую очередь — убрать условие');
    ok(at >= 0 && at < brief.indexOf('claim-1 — опровергнут'), brief);
    const none = buildRetryBrief(red, [], { retryInstruction: 'н/п' });
    ok(none !== null && !none.includes('в первую очередь'));
  });

  it('переносит расхождения ревью, инварианты и регрессии', () => {
    const brief = buildRetryBrief(
      input({
        confirmedReviewFindings: 2,
        brokenInvariants: ['политика перестала быть единственной точкой решения'],
        regressions: ['отвалился парсер набора гейтов'],
      }),
      [],
    );
    ok(brief !== null);
    match(brief, /расхождений из ревью: 2/);
    match(brief, /единственной точкой решения/);
    match(brief, /парсер набора гейтов/);
  });

  it('отсутствие прогресса называет прямо', () => {
    const brief = buildRetryBrief(input({ noProgress: true }), []);
    ok(brief !== null);
    match(brief, /патч этой попытки совпал с предыдущим/);
  });

  it('с деталями несёт текст пункта, слова рецензента и находки — с подписью, чьи они', () => {
    const brief = buildRetryBrief(
      input({ claims: [{ id: 'claim-2', status: '❌' }], confirmedReviewFindings: 1 }),
      [],
      {
        claimTexts: new Map([['claim-2', '| claim-2 | сторона ровно 120 см — не негабарит | тест |']]),
        whatToFix: new Map([['claim-2', 'сравнивать longestSideCm напрямую, без сложения']]),
        findings: [
          { text: 'лишняя арифметика в surchargeFor', evidence: 'src/oversize.ts:12', anchored: true },
          { text: 'без места', evidence: '', anchored: false },
        ],
      },
    );
    ok(brief !== null);
    match(brief, /claim-2 — опровергнут \(❌\): \| claim-2 \| сторона ровно 120 см/);
    match(brief, /по словам рецензента, чинить: сравнивать longestSideCm/);
    match(brief, /Находки ревью \(слова рецензента/);
    match(brief, /лишняя арифметика в surchargeFor — src\/oversize\.ts:12/);
    match(brief, /без места _\(место в патче не найдено\)_/);
    // Находка с местом идёт раньше находки без него.
    ok(brief.indexOf('лишняя арифметика') < brief.indexOf('без места'));
  });

  it('хвост вывода упавшего гейта уходит в бриф, а не одна последняя строка', () => {
    const brief = buildRetryBrief(input(), [
      gate({ outputTail: 'not ok 3 - сторона ровно 120\n  AssertionError: expected 0\n2 failing' }),
    ]);
    ok(brief !== null);
    match(brief, /AssertionError: expected 0/);
    match(brief, /2 failing/);
  });

  it('внутренние кадры стека не съедают окно хвоста: видны ОБА провала', () => {
    // Замер 2026-09-05 (`bench`, `perf-keep-behavior`): у `node --test` два упавших теста
    // дают 21 строку, 8 из них — кадры `node:internal/...`. В окно 12 строк попадал только
    // ВТОРОЙ провал, и повторная попытка чинила половину проблемы. Три попытки подряд
    // модель не починила регрессию, видя ровно это.
    const out = [
      '✖ failing tests:',
      'test at test/stock.test.ts:43:1',
      '✖ нет позиции на складе (0.1ms)',
      "  TypeError: Cannot read properties of undefined (reading 'qty')",
      '      at TestContext.<anonymous> (file:///ws/test/stock.test.ts:43:78)',
      '      at Test.runInAsyncScope (node:async_hooks:226:14)',
      '      at Test.run (node:internal/test_runner/test:1201:25)',
      '      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3)',
      'test at test/stock.test.ts:47:1',
      '✖ сумма по складам (0.2ms)',
      "  TypeError: Cannot read properties of undefined (reading 'qty')",
      '      at TestContext.<anonymous> (file:///ws/test/stock.test.ts:47:12)',
      '      at Test.runInAsyncScope (node:async_hooks:226:14)',
      '      at Test.run (node:internal/test_runner/test:1201:25)',
    ].join('\n');
    const brief = buildRetryBrief(input(), [gate({ outputTail: out })]);
    ok(brief !== null);
    match(brief, /test\/stock\.test\.ts:43/);
    match(brief, /test\/stock\.test\.ts:47/);
    // Место падения в коде проекта — остаётся: по нему и чинят.
    match(brief, /file:\/\/\/ws\/test\/stock\.test\.ts:47:12/);
    strictEqual(/node:internal/.test(brief), false, 'внутренние кадры выброшены');
    strictEqual(/node:async_hooks/.test(brief), false);
  });

  it('кадр из node_modules тоже выброшен, а строка про сам файл — нет', () => {
    const out = [
      'FAIL src/report.ts',
      '      at Module._compile (/ws/node_modules/ts-node/src/index.ts:1)',
      '  Ожидалось 0, получено NaN',
    ].join('\n');
    const brief = buildRetryBrief(input(), [gate({ outputTail: out })]);
    ok(brief !== null);
    match(brief, /Ожидалось 0, получено NaN/);
    match(brief, /FAIL src\/report\.ts/);
    strictEqual(/node_modules/.test(brief), false);
  });

  it('визитка node --test (счётчики + повторный список провалов) не вытесняет саму ошибку', () => {
    // Живой вывод (сокращённый) d2-devstral-vat-rounding, chunk-1-attempt-3, 2026-09-25:
    // модель добавила `import { Line } from "../src/lines.ts"` при экспорте `Line` только
    // типом (`export interface Line`) — Node стирает интерфейсы при исполнении TS и падает
    // на загрузке модуля. Окно ретрая ДО фикса состояло целиком из строк ниже SyntaxError:
    // счётчиков и повторного «✖ failing tests:» — три попытки подряд без единого слова о
    // причине.
    const out = [
      '✔ деньги (4.9425ms)',
      'file:///ws/test/vat.test.ts:4',
      'import { Line } from "../src/lines.ts";',
      '         ^^^^',
      "SyntaxError: The requested module '../src/lines.ts' does not provide an export named 'Line'",
      '    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)',
      '    at async ModuleJob.run (node:internal/modules/esm/module_job:431:5)',
      'Node.js v24.18.0',
      '✖ test\\vat.test.ts (166.0493ms)',
      'ℹ tests 11',
      'ℹ suites 3',
      'ℹ pass 10',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 257.3565',
      '✖ failing tests:',
      'test at test\\vat.test.ts:1:1',
      '✖ test\\vat.test.ts (166.0493ms)',
      "  'test failed'",
    ].join('\n');
    const brief = buildRetryBrief(input(), [gate({ outputTail: out })]);
    ok(brief !== null);
    match(brief, /does not provide an export named 'Line'/);
    match(brief, /import \{ Line \} from "\.\.\/src\/lines\.ts"/);
    strictEqual(/ℹ tests \d/.test(brief), false, 'счётчики выброшены');
    strictEqual(/✖ failing tests:/.test(brief), false, 'заголовок повтора выброшен');
    // Живая строка «✖ test\vat.test.ts (166.0493ms)» (до заголовка recap) остаётся —
    // резать нужно только её повтор внутри «✖ failing tests:», не первое появление.
    strictEqual((brief.match(/✖ test\\vat\.test\.ts \(166\.0493ms\)/g) ?? []).length, 1);
    strictEqual(/'test failed'/.test(brief), false);
  });

  it('живая строка «✖ <говорящее имя теста> (Nms)» — единственный диагноз без сообщения об ошибке — не вырезается', () => {
    // code-review-all, 2026-09-26: безусловный фильтр по форме «✖ … (Nms)» резал бы и
    // ЖИВОЙ (первый) экземпляр — а для теста без явного assert.message (assert.fail(),
    // кастомный throw без текста) говорящее название it() остаётся ЕДИНСТВЕННЫМ местом с
    // содержательным текстом. Recap-блок здесь есть — режется только его повтор.
    const out = [
      "✖ сумма по складам не сходится с ожидаемой (2.1ms)",
      '  AssertionError [ERR_ASSERTION]',
      '',
      'ℹ tests 5',
      'ℹ pass 4',
      'ℹ fail 1',
      '✖ failing tests:',
      'test at test/stock.test.ts:12:3',
      "✖ сумма по складам не сходится с ожидаемой (2.1ms)",
      "  'test failed'",
    ].join('\n');
    const brief = buildRetryBrief(input(), [gate({ outputTail: out })]);
    ok(brief !== null);
    match(brief, /сумма по складам не сходится с ожидаемой/);
    strictEqual((brief.match(/сумма по складам не сходится с ожидаемой/g) ?? []).length, 1, 'живая строка одна, recap-повтор вырезан');
    strictEqual(/✖ failing tests:/.test(brief), false);
    strictEqual(/test at test\/stock\.test\.ts/.test(brief), false);
  });

  it('«н\/п» в графе «что чинить» не показывается', () => {
    const brief = buildRetryBrief(input({ claims: [{ id: 'claim-1', status: '⚠' }] }), [], {
      whatToFix: new Map([['claim-1', 'н/п']]),
    });
    ok(brief !== null);
    strictEqual(/по словам рецензента/.test(brief), false);
  });

  it('не даёт указаний, что чинить, — только факты', () => {
    const brief = buildRetryBrief(input(), [gate()]);
    ok(brief !== null);
    // Императив здесь запрещён: диагноз ошибки из последней строки вывода не следует, и
    // подсказка уверенным тоном уводит исполнителя в неверном направлении.
    // БЕЗ `\b`: граница слова в JS считается по ASCII, кириллица в `\w` не входит, и
    // утверждение с ней не могло стать ложным ни при каком содержимом — тест охранял
    // запрет, не проверяя его.
    strictEqual(/(^|[^а-яё])(исправь|почини|надо)([^а-яё]|$)/i.test(brief), false);
  });
});
