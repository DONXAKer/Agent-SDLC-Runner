import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { packedWeightG, volumetricWeightG, FRAGILITY_FACTOR } from '../src/index.ts';
test('packing factor applies before one rounding to 100 g', () => {
  strictEqual(packedWeightG([20, 25, 10]), 1200);
  strictEqual(packedWeightG([15, 15, 10]), 600);
  strictEqual(packedWeightG([11, 10, 10]), 300);
  strictEqual(volumetricWeightG([11, 10, 10]), 300);
});
test('order independent, input immutable, original coefficient unchanged', () => {
  const dimensions = Object.freeze([11, 10, 10] as const);
  strictEqual(packedWeightG(dimensions), packedWeightG([10, 11, 10]));
  deepStrictEqual(dimensions, [11, 10, 10]);
  strictEqual(FRAGILITY_FACTOR, 1.5);
});
