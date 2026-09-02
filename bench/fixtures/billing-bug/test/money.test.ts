/**
 * Тесты денег: правила округления и арифметики — единственное место, где они зафиксированы.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { add, formatRub, percent, rub, subtract } from '../src/index.ts';

describe('деньги', () => {
  it('рубли переводятся в копейки', () => {
    strictEqual(rub(249), 24_900);
    strictEqual(rub(0.5), 50);
  });

  it('сумма и разность', () => {
    strictEqual(add(100, 250, 50), 400);
    strictEqual(subtract(400, 100), 300);
  });

  it('разность не уходит ниже нуля', () => {
    strictEqual(subtract(100, 150), 0);
  });

  it('процент округляется половиной вверх', () => {
    strictEqual(percent(1000, 20), 200);
    strictEqual(percent(105, 10), 11); // 10.5 — вверх, не отбрасывание
    strictEqual(percent(505, 20), 101); // 101.0 — без лишнего +1
    strictEqual(percent(999, 7), 70); // 69.93 — вверх до 70, не 69
  });

  it('форматирование — разряды пробелом, копейки после запятой', () => {
    strictEqual(formatRub(123_456), '1 234,56 ₽');
  });
});
