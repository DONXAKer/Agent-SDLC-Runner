/**
 * Тесты эталона: мок банка обязан соответствовать контракту из README.
 *
 * Это тесты СТЕНДА, а не клиента: мок — единственная реализация контракта в репозитории,
 * и его расхождение с README делает бессмысленным всё, что клиент проверяет через него.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mockBank } from '../src/index.ts';

describe('мок банка: контракт', () => {
  it('успешное списание: HTTP 200 и ok:true с charge_id', () => {
    const bank = mockBank();
    const res = bank('/charge', '{"card_token":"tok_ok","amount_minor":"12345","currency":"RUB"}');
    strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    strictEqual(body.ok, true);
    strictEqual(typeof body.charge_id, 'string');
  });

  it('отказ — тоже HTTP 200, распознаётся по ok:false', () => {
    const bank = mockBank();
    const res = bank('/charge', '{"card_token":"tok_decline","amount_minor":"100","currency":"RUB"}');
    strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    strictEqual(body.ok, false);
    strictEqual(body.error.code, 'insufficient_funds');
  });

  it('неизвестная карта — отказ unknown_card', () => {
    const bank = mockBank();
    const res = bank('/charge', '{"card_token":"tok_zzz","amount_minor":"100","currency":"RUB"}');
    const body = JSON.parse(res.body);
    strictEqual(body.ok, false);
    strictEqual(body.error.code, 'unknown_card');
  });

  it('подозрение на мошенничество — свой код отказа', () => {
    const bank = mockBank();
    const res = bank('/charge', '{"card_token":"tok_fraud","amount_minor":"100","currency":"RUB"}');
    const body = JSON.parse(res.body);
    strictEqual(body.error.code, 'fraud_suspected');
  });
});
