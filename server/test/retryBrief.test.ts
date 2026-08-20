/**
 * Выжимка причин красного для следующей попытки.
 *
 * Проверяется как чистая функция на фиксированном входе — I/O у неё нет по построению.
 * Отдельная планка: в блоке не должно появляться утверждений, которых нет в данных.
 */

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult, VerdictInput } from '@sdlc-runner/shared';

import { buildRetryBrief } from '../src/verdict/retryBrief.ts';

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
    ...over,
  };
}

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
