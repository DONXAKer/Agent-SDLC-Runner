/**
 * Тесты объёмного веса с учётом упаковки: (д×ш×в)/5 × 1.2, округление вверх до 100 г.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PACKING_FACTOR, packedWeightG, volumetricWeightG } from '../src/index.ts';

describe('объёмный вес с упаковкой', () => {
  it('коэффициент упаковки зафиксирован приёмкой', () => {
    strictEqual(PACKING_FACTOR, 1.2);
  });

  it('ровная ячейка: 20×25×10 → 1000 г → ×1.2 = 1200 → 1200', () => {
    strictEqual(packedWeightG([20, 25, 10]), 1200);
  });

  it('округление вверх до 100 г: 15×15×10 → 450 г → ×1.2 = 540 → 600', () => {
    strictEqual(packedWeightG([15, 15, 10]), 600);
  });

  it('коэффициент применяется до округления: 10×10×5 → 100 г → ×1.2 = 120 → 200', () => {
    strictEqual(packedWeightG([10, 10, 5]), 200);
  });

  it('порядок сторон не важен', () => {
    strictEqual(packedWeightG([10, 15, 15]), packedWeightG([15, 15, 10]));
  });

  it('всегда не меньше голых габаритов', () => {
    strictEqual(packedWeightG([20, 25, 10]) >= volumetricWeightG([20, 25, 10]), true);
    strictEqual(packedWeightG([15, 15, 10]) >= volumetricWeightG([15, 15, 10]), true);
  });
});
