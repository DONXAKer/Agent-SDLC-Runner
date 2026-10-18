/**
 * Тесты валидации покупателя.
 *
 * Правила email и телефона: фиксирован набор кодов нарушений и их порядок — сначала
 * 'email', затем 'phone'. Пустой список — покупатель валиден.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Customer } from '../src/customer.ts';
import { validateCustomer } from '../src/index.ts';

function customer(overrides: Partial<Customer> = {}): Customer {
  return { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567', ...overrides };
}

describe('валидация покупки', () => {
  it('валидные данные — пустой список', () => {
    strictEqual(validateCustomer(customer()).length, 0);
  });

  it('email с цифрами в локальной части — валиден', () => {
    deepStrictEqual(validateCustomer(customer({ email: '8@example.ru' })), []);
  });

  it('email без @ — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan' })), ['email']);
  });

  it('email с двумя @ — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan@@example.ru' })), ['email']);
  });

  it('email с пустой локальной частью — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: '@example.ru' })), ['email']);
  });

  it('email с доменом без точки — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan@example' })), ['email']);
  });

  it('email с доменом, начинающимся на точку — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan@.example.ru' })), ['email']);
  });

  it('email с доменом, заканчивающимся на точку — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan@example.' })), ['email']);
  });

  it('email с пробелом — нарушение email', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan@ex ample.ru' })), ['email']);
  });

  it('телефон 8 + 10 цифр — валиден', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '89001234567' })), []);
  });

  it('телефон со звёздочкой — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '*79001234567' })), ['phone']);
  });

  it('телефон с пробелами — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '+7 900 123 45 67' })), ['phone']);
  });

  it('телефон с дефисами — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '+7-900-123-45-67' })), ['phone']);
  });

  it('телефон со скобками — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '+7(900)1234567' })), ['phone']);
  });

  it('телефон с 9 цифрами после +7 — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '+7900123456' })), ['phone']);
  });

  it('телефон с 11 цифрами после +7 — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '+790012345678' })), ['phone']);
  });

  it('телефон без цифры после 8 — нарушение phone', () => {
    deepStrictEqual(validateCustomer(customer({ phone: '8' })), ['phone']);
  });

  it('оба нарушения — email первым, phone вторым', () => {
    deepStrictEqual(validateCustomer(customer({ email: 'ivan', phone: '123' })), ['email', 'phone']);
  });
});
