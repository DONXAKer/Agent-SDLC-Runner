/**
 * Тесты расхода на поездку: километры × норма (дл/100 км = мл/км), вверх до 100 мл.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fuelMl } from '../src/index.ts';

describe('расход на поездку', () => {
  it('ровный акт: 100 км легкового = 100 × 76 = 7600 мл', () => {
    strictEqual(fuelMl(100, 'car'), 7600);
  });

  it('округление вверх до 100 мл: 13 км фургона = 13 × 115 = 1495 мл → 1500', () => {
    strictEqual(fuelMl(13, 'van'), 1500);
  });

  it('неизвестный класс — null, как у rateFor', () => {
    strictEqual(fuelMl(50, 'motorcycle'), null);
  });

  it('нулевой пробег — нулевой расход', () => {
    strictEqual(fuelMl(0, 'truck'), 0);
  });
});
