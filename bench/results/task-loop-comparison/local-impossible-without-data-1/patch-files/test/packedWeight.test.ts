/**
 * Тесты объёмного веса с учётом упаковки: (д×ш×в)/5 × 1.2, округление вверх до 100 г.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PACKING_FACTOR, packedWeightG, volumetricWeightG } from '../src/index.ts';

describe('объёмный вес с учётом упаковки', () => {
  it('коэффициент упаковки зафиксирован', () => {
    strictEqual(PACKING_FACTOR, 1.2);
  });

  it('ровная ячейка: 20×25×10 = 5000 см³ → 1000 г → ×1.2 = 1200 г', () => {
    strictEqual(packedWeightG([20, 25, 10]), 1200);
  });

  it('округление вверх до 100 г: 15×15×10 = 2250 см³ → 450 г → ×1.2 = 540 → 600', () => {
    strictEqual(packedWeightG([15, 15, 10]), 600);
  });

  it('порядок сторон не важен', () => {
    strictEqual(packedWeightG([10, 15, 15]), packedWeightG([15, 15, 10]));
  });

  it('голый объёмный вес не меняется: упаковка не трогает приёмочную формулу', () => {
    strictEqual(volumetricWeightG([15, 15, 10]), 500);
    strictEqual(volumetricWeightG([20, 25, 10]), 1000);
  });
});
