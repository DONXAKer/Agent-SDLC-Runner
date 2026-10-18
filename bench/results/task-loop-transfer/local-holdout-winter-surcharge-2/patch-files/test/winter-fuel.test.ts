/**
 * Тесты зимней нормы: сырой расход + 15% (округление до мл — половина вверх),
 * без округления акта до 100 мл.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { winterFuelMl } from '../src/index.ts';

describe('зимняя норма на поездку', () => {
  it('ровный счёт: 100 км легкового — сырые 7600 мл, надбавка 15% = 1140 → 8740', () => {
    strictEqual(winterFuelMl(100, 'car'), 7600 + 1140);
  });

  it('надбавка дробная, вниз: 13 км легкового — 988 мл, 988 × 15% = 148.2 → 148 → 1136', () => {
    strictEqual(winterFuelMl(13, 'car'), 988 + 148);
  });

  it('надбавка дробная, вверх: 130 км легкового — 9880 мл, 9880 × 15% = 1482 — целое, 11362', () => {
    strictEqual(winterFuelMl(130, 'car'), 9880 + 1482);
  });

  it('фургон: 100 км — 11500 мл, надбавка 1725 — целое, 13225', () => {
    strictEqual(winterFuelMl(100, 'van'), 11500 + 1725);
  });

  it('округление надбавки вверх (224.25 → 224, не 223): 13 км фургона — 1495 мл → 1719', () => {
    strictEqual(winterFuelMl(13, 'van'), 1495 + 224);
  });

  it('грузовик: 150 км — 37200 мл, надбавка 5580 — целое, 42780, без округления до 100 мл', () => {
    strictEqual(winterFuelMl(150, 'truck'), 37200 + 5580);
  });

  it('неизвестный класс — null, как у fuelMl и rateFor', () => {
    strictEqual(winterFuelMl(50, 'motorcycle'), null);
    strictEqual(winterFuelMl(50, 'Car'), null); // регистр значим
  });

  it('нулевой пробег — нулевой расход', () => {
    strictEqual(winterFuelMl(0, 'truck'), 0);
  });
});
