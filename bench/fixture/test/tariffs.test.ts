import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANONYMOUS } from '../src/discounts.ts';
import type { Customer } from '../src/discounts.ts';
import { TARIFF_TABLE, WEIGHT_STEPS, basePrice, priceFor, weightStep } from '../src/tariffs.ts';
import type { Order } from '../src/tariffs.ts';
import { ZONES, zoneOf } from '../src/zones.ts';

const GOLD: Customer = { id: 'g-1', tier: 'gold' };

function order(over: Partial<Order> = {}): Order {
  return {
    regionCode: 77,
    weightG: 900,
    dimensionsCm: [20, 15, 10],
    customer: ANONYMOUS,
    ...over,
  };
}

describe('весовые ступени', () => {
  it('границы включающие', () => {
    strictEqual(weightStep(1), 0);
    strictEqual(weightStep(500), 0);
    strictEqual(weightStep(501), 1);
    strictEqual(weightStep(1_000), 1);
    strictEqual(weightStep(2_000), 2);
    strictEqual(weightStep(5_000), 3);
    strictEqual(weightStep(5_001), 4);
  });
});

describe('тарифная таблица', () => {
  it('заполнена для всех зон и всех ступеней', () => {
    for (const zone of ZONES) {
      strictEqual(TARIFF_TABLE[zone].length, WEIGHT_STEPS, `зона ${zone}`);
    }
  });

  it('цена растёт с весом внутри зоны', () => {
    for (const zone of ZONES) {
      const row = TARIFF_TABLE[zone];
      for (let i = 1; i < row.length; i++) {
        strictEqual(row[i]! > row[i - 1]!, true, `зона ${zone}, ступень ${i}`);
      }
    }
  });

  it('любой вес попадает в заполненную ступень', () => {
    // Ступень, посчитанная weightStep, обязана существовать в строке каждой зоны: иначе
    // basePrice бросил бы «тариф не заполнен» на обычном отправлении.
    for (const zone of ZONES) {
      for (const weightG of [1, 500, 501, 2_000, 5_000, 50_000]) {
        strictEqual(typeof basePrice(zone, weightG), 'number', `зона ${zone}, вес ${weightG}`);
      }
    }
  });
});

describe('зоны', () => {
  it('код региона определяет зону, неизвестный уходит в дальнюю', () => {
    strictEqual(zoneOf(77), 'msk');
    strictEqual(zoneOf(78), 'center');
    strictEqual(zoneOf(66), 'ural');
    strictEqual(zoneOf(14), 'far');
    strictEqual(zoneOf(999), 'far');
  });
});

describe('расчёт цены', () => {
  it('разовое отправление считается по базе без скидки', () => {
    deepStrictEqual(priceFor(order()), { zone: 'msk', base: 24_900, discount: 0, total: 24_900 });
  });

  it('скидка лояльности считается от базы зоны', () => {
    deepStrictEqual(priceFor(order({ customer: GOLD })), {
      zone: 'msk',
      base: 24_900,
      discount: 2_988,
      total: 21_912,
    });
  });

  it('дальняя зона берёт свой тариф', () => {
    strictEqual(priceFor(order({ regionCode: 14, weightG: 300 })).base, 48_925);
  });
});
