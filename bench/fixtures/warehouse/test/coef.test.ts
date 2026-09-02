/**
 * Тесты объёмного веса: формула (д×ш×в)/5 в граммах и округление вверх до 100 г.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FRAGILITY_FACTOR, volumetricWeightG } from '../src/index.ts';

describe('объёмный вес', () => {
  it('ровная ячейка: 20×25×10 = 5000 см³ → 1000 г', () => {
    strictEqual(volumetricWeightG([20, 25, 10]), 1000);
  });

  it('округление вверх до 100 г: 15×15×10 = 2250 см³ → 450 г → 500', () => {
    strictEqual(volumetricWeightG([15, 15, 10]), 500);
  });

  it('порядок сторон не важен', () => {
    strictEqual(volumetricWeightG([10, 15, 15]), volumetricWeightG([15, 15, 10]));
  });

  it('коэффициент хрупкости зафиксирован', () => {
    strictEqual(FRAGILITY_FACTOR, 1.5);
  });
});
