/**
 * Тесты зимней нормы: сырой расход (без округления до 100 мл) + 15% надбавка,
 * округлённая до целого мл общим правилом пакета (половина вверх).
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { winterFuelMl } from '../src/index.ts';

describe('зимняя норма', () => {
  it('ровный расход: 100 км легкового = 7600 + 15% = 8740 мл', () => {
    strictEqual(winterFuelMl(100, 'car'), 8740);
  });

  it('сырой расход без округления до 100 мл: 13 км фургона = 1495 + 15% = 1495 + 224 = 1719', () => {
    strictEqual(winterFuelMl(13, 'van'), 1719);
  });

  it('надбавка округляется по половине вверх: 7 км грузового = 1736 + 260.4 → 260 = 1996', () => {
    strictEqual(winterFuelMl(7, 'truck'), 1996);
  });

  it('до 100 мл итог не округляется: 1 км легкового = 76 + 11.4 → 11 = 87', () => {
    strictEqual(winterFuelMl(1, 'car'), 87);
  });

  it('неизвестный класс — null, как у fuelMl', () => {
    strictEqual(winterFuelMl(50, 'motorcycle'), null);
  });

  it('нулевой пробег — нулевой расход', () => {
    strictEqual(winterFuelMl(0, 'truck'), 0);
  });
});
