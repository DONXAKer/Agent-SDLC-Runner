/**
 * Тесты расхода на поездку с прицепом: норма класса + 20 мл/км, вверх до 100 мл.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trailerFuelMl, trailerRateFor, TRAILER_SURCHARGE_ML } from '../src/index.ts';
import { fuelMl } from '../src/index.ts';

describe('надбавка за прицеп', () => {
  it('фиксированная, 20 мл/км (= 2 л/100 км)', () => {
    strictEqual(TRAILER_SURCHARGE_ML, 20);
  });

  it('норма с прицепом = норма класса + надбавка: truck 248 + 20 = 268', () => {
    strictEqual(trailerRateFor('truck'), 268);
  });

  it('неизвестный класс — null, как у rateFor (без молчаливого дефолта)', () => {
    strictEqual(trailerRateFor('motorcycle'), null);
  });
});

describe('расход на поездку с прицепом', () => {
  it('ровный акт: 100 км легкового = 100 × (76 + 20) = 9600 мл', () => {
    strictEqual(trailerFuelMl(100, 'car'), 9600);
  });

  it('округление вверх: 13 км фургона = 13 × (115 + 20) = 1755 мл → 1800', () => {
    strictEqual(trailerFuelMl(13, 'van'), 1800);
  });

  it('нулевой пробег — нулевой расход', () => {
    strictEqual(trailerFuelMl(0, 'truck'), 0);
  });

  it('неизвестный класс — null', () => {
    strictEqual(trailerFuelMl(50, 'motorcycle'), null);
  });
});

describe('одиночный расход не меняется', () => {
  it('с прицепом всегда больше одиночного на той же дистанции и классе', () => {
    const solo = fuelMl(13, 'van');
    const withTrailer = trailerFuelMl(13, 'van');
    strictEqual(solo, 1500);
    strictEqual(withTrailer, 1800);
  });

  it('одиночный расход на 100 км легкового = 7600 мл (как есть)', () => {
    strictEqual(fuelMl(100, 'car'), 7600);
  });
});
