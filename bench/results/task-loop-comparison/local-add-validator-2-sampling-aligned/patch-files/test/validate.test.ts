/**
 * Тесты валидации покупателя.
 *
 * validateCustomer — чистая функция: на данные формы возвращает список кодов
 * нарушений в фиксированном порядке. Здесь закреплены правила email и телефона.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCustomer } from '../src/index.ts';

const validCustomer = { name: 'Иван', email: 'ivan@example.ru', phone: '+79001234567' };

describe('валидация покупателя', () => {
  it('валидный покупатель — пустой список', () => {
    deepStrictEqual(validateCustomer(validCustomer), []);
  });

  // email -------------------------------------------------------------

  it('email: валидные адреса', () => {
    for (const email of ['ivan@example.ru', 'a@b.co', 'user@sub.domain.org']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, email }), []);
    }
  });

  it('email: без «@», две «@», пустая локальная часть', () => {
    for (const email of ['ivanexample.ru', 'ivan@@example.ru', '@example.ru']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, email }), ['email']);
    }
  });

  it('email: домен без точки и точки на краях домена', () => {
    for (const email of ['ivan@example', 'ivan@.example.ru', 'ivan@example.ru.']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, email }), ['email']);
    }
  });

  it('email: пробелы в адресе', () => {
    for (const email of ['ivan @example.ru', 'ivan@example .ru', ' ivan@example.ru']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, email }), ['email']);
    }
  });

  // телефон -------------------------------------------------------------

  it('телефон: валидные форматы', () => {
    for (const phone of ['+79001234567', '89001234567']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, phone }), []);
    }
  });

  it('телефон: другой префикс, лишние и недостающие цифры', () => {
    for (const phone of ['+19001234567', '+7900123456', '+790012345678', '79001234567']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, phone }), ['phone']);
    }
  });

  it('телефон: лишние символы', () => {
    for (const phone of ['+7 900 123 45 67', '+7(900)123-4567', '+7900123456 7']) {
      deepStrictEqual(validateCustomer({ ...validCustomer, phone }), ['phone']);
    }
  });

  it('порок и email, и телефон: коды в порядке email, phone', () => {
    const bad = { name: 'Иван', email: 'ivan', phone: '123' };
    deepStrictEqual(validateCustomer(bad), ['email', 'phone']);
  });
});
