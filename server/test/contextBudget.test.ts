/**
 * `contextBudget.ts` — чистые функции, общая математика `max_tokens` по остатку окна
 * для `LoopExecutor` и `StepExecutor` (code-review-all, 2026-09-11).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BYTES_PER_TOKEN_ESTIMATE,
  MIN_MAX_TOKENS,
  budgetParams,
  estimateMessageTokens,
  marginFor,
  maxTokensForRemaining,
} from '../src/exec/contextBudget.ts';

describe('maxTokensForRemaining', () => {
  it('считает остаток минус запас', () => {
    deepStrictEqual(maxTokensForRemaining(4096, 3000, 512), { maxTokens: 584, clamped: false });
  });

  it('остаток ниже пола — клэмп на MIN_MAX_TOKENS с пометкой', () => {
    deepStrictEqual(maxTokensForRemaining(4096, 4000, 512), { maxTokens: MIN_MAX_TOKENS, clamped: true });
  });

  it('остаток глубоко в минусе — тот же пол, тот же признак клэмпа', () => {
    deepStrictEqual(maxTokensForRemaining(4096, 8000, 512), { maxTokens: MIN_MAX_TOKENS, clamped: true });
  });

  it('остаток ровно на полу — не считается клэмпом (строго меньше)', () => {
    deepStrictEqual(maxTokensForRemaining(1024, 256, 512), { maxTokens: 256, clamped: false });
  });
});

describe('budgetParams', () => {
  it('contextWindow не задан — params как есть, колбэк не зовётся', () => {
    let called = false;
    const out = budgetParams({ contextWindow: undefined, params: { seed: 1 }, promptTokens: 9999, marginTokens: 0, onClamped: () => (called = true) });
    deepStrictEqual(out, { seed: 1 });
    strictEqual(called, false);
    strictEqual(budgetParams({ contextWindow: undefined, params: undefined, promptTokens: 0, marginTokens: 0, onClamped: () => {} }), null);
  });

  it('остаток окна; явный max_tokens оператора перекрывает вычисленный', () => {
    deepStrictEqual(budgetParams({ contextWindow: 4096, params: null, promptTokens: 3000, marginTokens: 512, onClamped: () => {} }), { max_tokens: 584 });
    deepStrictEqual(
      budgetParams({ contextWindow: 4096, params: { max_tokens: 999, temperature: 0.1 }, promptTokens: 3000, marginTokens: 512, onClamped: () => {} }),
      { max_tokens: 999, temperature: 0.1 },
    );
  });

  it('ниже пола — колбэк получает пол', () => {
    const seen: number[] = [];
    deepStrictEqual(
      budgetParams({ contextWindow: 4096, params: null, promptTokens: 4000, marginTokens: 512, onClamped: (m) => seen.push(m) }),
      { max_tokens: MIN_MAX_TOKENS },
    );
    deepStrictEqual(seen, [MIN_MAX_TOKENS]);
  });
});

describe('marginFor', () => {
  it('масштабируется с потолком результата и множителем', () => {
    strictEqual(marginFor(12_000, 3), Math.ceil(12_000 / BYTES_PER_TOKEN_ESTIMATE) * 3);
    strictEqual(marginFor(12_000, 3), 9_000);
  });

  it('множитель 1 — запас равен одному результату в токенах', () => {
    strictEqual(marginFor(4_000, 1), 1_000);
  });
});

describe('estimateMessageTokens', () => {
  it('сумма длин content, делённая на BYTES_PER_TOKEN_ESTIMATE (ASCII: символы = байты)', () => {
    const messages = [{ content: 'a'.repeat(400) }, { content: 'b'.repeat(400) }];
    strictEqual(estimateMessageTokens(messages), 200);
  });

  it('пустой список — ноль', () => {
    strictEqual(estimateMessageTokens([]), 0);
  });

  it('кириллица считается по БАЙТАМ UTF-8, не по символам (live-найдено, 2026-09-14)', () => {
    // Кириллица — 2 байта на символ в UTF-8, 1 code unit в `.length`: счёт по `.length`
    // (как раньше) занижал бы оценку вдвое на промптах этого проекта (конвенция — русский,
    // CLAUDE.md). 100 кириллических символов = 200 байт = 50 токенов при делителе 4, а не
    // 25, как дал бы счёт по `.length`.
    const messages = [{ content: 'привет'.repeat(100) }]; // 600 символов, 1200 байт UTF-8
    const bySymbols = Math.ceil(600 / 4);
    const byBytes = Math.ceil(1200 / 4);
    strictEqual(estimateMessageTokens(messages), byBytes);
    strictEqual(estimateMessageTokens(messages) > bySymbols, true, 'оценка обязана расти вместе с реальным размером в байтах');
  });
});
