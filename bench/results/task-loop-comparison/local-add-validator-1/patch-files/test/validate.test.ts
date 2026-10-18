/**
 * Тесты валидации покупателя: правила email и телефона — единственное место, где они зафиксированы.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCustomer } from '../src/index.ts';
import type { Customer } from '../src/customer.ts';

const valid: Customer = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

describe('валидация покупателя', () => {
  it('валидный покупатель — пустой список', () => {
    deepStrictEqual(validateCustomer(valid), []);
  });

  it('телефон с 8 и десятью цифрами — валиден', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '89001234567' }), []);
  });

  it('нарушение email — код email', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivanexample.ru' }), ['email']);
  });

  it('нарушение телефона — код phone', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7900123456' }), ['phone']);
  });

  it('оба нарушения — порядок email, затем phone', () => {
    deepStrictEqual(
      validateCustomer({ ...valid, email: 'ivan example.ru', phone: '9001234567' }),
      ['email', 'phone'],
    );
  });

  it('email: ровно одна @', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@@example.ru' }), ['email']);
    deepStrictEqual(validateCustomer({ ...valid, email: '@example.ru' }), ['email']);
  });

  it('email: локальная часть непустая', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: '@example.ru' }), ['email']);
  });

  it('email: домен содержит точку', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@example' }), ['email']);
  });

  it('email: домен не начинается и не заканчивается на точку', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@.example.ru' }), ['email']);
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@example.ru.' }), ['email']);
  });

  it('email: пробелов нигде нет', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan @example.ru' }), ['email']);
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@exa mple.ru' }), ['email']);
  });

  it('телефон: только цифры после префикса', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7 9001234567' }), ['phone']);
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7(900)123-4567' }), ['phone']);
    deepStrictEqual(validateCustomer({ ...valid, phone: '+790012345678' }), ['phone']);
    deepStrictEqual(validateCustomer({ ...valid, phone: '79001234567' }), ['phone']);
  });
});
