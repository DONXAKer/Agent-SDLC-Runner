import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatRub, percent, rub, subtract } from '../src/money.ts';

describe('деньги', () => {
  it('рубли переводятся в копейки без дробей', () => {
    strictEqual(rub(249), 24_900);
    strictEqual(rub(489.25), 48_925);
  });

  it('процент округляется половиной ВВЕРХ', () => {
    // 50,5 копейки — ровно половина, и она обязана уйти вверх, а не к ближайшему чётному
    // и не вниз усечением.
    strictEqual(percent(101, 50), 51);
    strictEqual(percent(48_925, 90), 44_033);
  });

  it('процент от круглой суммы считается точно', () => {
    strictEqual(percent(19_900, 12), 2_388);
    strictEqual(percent(24_900, 12), 2_988);
  });

  it('вычитание не уходит ниже нуля', () => {
    strictEqual(subtract(100, 40), 60);
    strictEqual(subtract(100, 250), 0);
  });

  it('сумма печатается с разрядами и копейками', () => {
    strictEqual(formatRub(24_900), '249,00 ₽');
    strictEqual(formatRub(159_900), '1 599,00 ₽');
    strictEqual(formatRub(48_925), '489,25 ₽');
  });
});
