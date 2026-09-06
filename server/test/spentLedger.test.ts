/**
 * Учёт потраченного по валютам (`SpentLedger`).
 *
 * Планка: рубли не складываются с долларами. `costUsd` у polza — рубли, и смешанная
 * сумма гасила бы бюджетный гард маршрута не по существу; гард сверяет потолок только
 * с тратами СВОЕЙ валюты.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpentLedger } from '../src/run/spentLedger.ts';

describe('SpentLedger', () => {
  it('валюты копятся раздельно: траты в RUB не входят в сумму USD', () => {
    const l = new SpentLedger();
    l.add('RUB', 350);
    l.add('USD', 0.42);
    l.add('RUB', 50);
    strictEqual(l.spent('RUB'), 400);
    strictEqual(l.spent('USD'), 0.42);
  });

  it('null-стоимость (локальный провайдер без цены) не портит сумму', () => {
    const l = new SpentLedger();
    l.add('USD', null);
    strictEqual(l.spent('USD'), 0);
  });

  it('неизвестная валюта — ноль, а не undefined', () => {
    const l = new SpentLedger();
    l.add('USD', 1);
    strictEqual(l.spent('EUR'), 0);
  });
});
