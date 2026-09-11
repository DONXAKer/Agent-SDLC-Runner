/**
 * `contextBudget.ts` — чистые функции, общая математика `max_tokens` по остатку окна
 * для `LoopExecutor` и `StepExecutor` (code-review-all, 2026-09-11).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BYTES_PER_TOKEN_ESTIMATE,
  MIN_MAX_TOKENS,
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
  it('сумма длин content, делённая на BYTES_PER_TOKEN_ESTIMATE', () => {
    const messages = [{ content: 'a'.repeat(400) }, { content: 'b'.repeat(400) }];
    strictEqual(estimateMessageTokens(messages), 200);
  });

  it('пустой список — ноль', () => {
    strictEqual(estimateMessageTokens([]), 0);
  });
});
