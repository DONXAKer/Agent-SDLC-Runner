/**
 * Тесты заказа.
 *
 * Здесь — контракт сборки суммы на клиентах без накоплений. Ступени скидки и её влияние на
 * заказ записаны в loyalty.test.ts, чтобы числа ступеней жили в одном файле.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { orderTotal, rub } from '../src/index.ts';

describe('заказ', () => {
  it('новый клиент платит сумму позиций целиком', () => {
    strictEqual(orderTotal({ id: 'n', spentTotalK: 0 }, rub(1_234.56)), 123_456);
  });

  it('клиент на границе первой ступени платит целиком', () => {
    strictEqual(orderTotal({ id: 'b', spentTotalK: rub(10_000) }, rub(1_000)), 100_000);
  });

  it('пустая корзина — ноль к оплате', () => {
    strictEqual(orderTotal({ id: 'n', spentTotalK: 0 }, 0), 0);
  });
});
