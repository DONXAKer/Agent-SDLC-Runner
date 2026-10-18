/**
 * Тесты валидации покупателя.
 *
 * validateCustomer — чистая функция: возвращает список кодов нарушений в фиксированном
 * порядке (сначала 'email', затем 'phone'). Пустой список — покупатель валиден.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCustomer } from '../src/index.ts';

const valid = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

describe('валидация покупателя', () => {
  it('валидный покупатель — пустой список', () => {
    deepStrictEqual(validateCustomer(valid), []);
  });

  it('телефон с 8 и десятью цифрами — валиден', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '89001234567' }), []);
  });

  it('email: две @ — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'a@b@c.ru' }), ['email']);
  });

  it('email: без @ — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan.example.ru' }), ['email']);
  });

  it('email: пустая локальная часть — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: '@example.ru' }), ['email']);
  });

  it('email: домен без точки — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@example' }), ['email']);
  });

  it('email: домен начинается с точки — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@.example.ru' }), ['email']);
  });

  it('email: домен заканчивается точкой — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan@example.ru.' }), ['email']);
  });

  it('email: пробел — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, email: 'ivan @example.ru' }), ['email']);
  });

  it('телефон: без префикса — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '9001234567' }), ['phone']);
  });

  it('телефон: девять цифр после +7 — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7900123456' }), ['phone']);
  });

  it('телефон: одиннадцать цифр после +7 — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+790012345678' }), ['phone']);
  });

  it('телефон: с пробелом — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7 9001234567' }), ['phone']);
  });

  it('телефон: с дефисом — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7-900-123-45-67' }), ['phone']);
  });

  it('телефон: с скобками — нарушение', () => {
    deepStrictEqual(validateCustomer({ ...valid, phone: '+7 (900) 123-45-67' }), ['phone']);
  });

  it('оба нарушения — порядок email, phone', () => {
    deepStrictEqual(
      validateCustomer({ name: 'Иван', email: 'bad', phone: '123' }),
      ['email', 'phone'],
    );
  });
});
