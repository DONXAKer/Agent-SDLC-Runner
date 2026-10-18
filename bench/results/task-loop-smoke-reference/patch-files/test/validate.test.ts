import { deepStrictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { validateCustomer } from '../src/index.ts';
const good = { name: 'Иван', email: 'a@b.ru', phone: '+79001234567' };
test('valid contact and alternate prefix', () => {
  deepStrictEqual(validateCustomer(good), []);
  deepStrictEqual(validateCustomer({ ...good, phone: '89001234567' }), []);
});
test('email boundaries', () => {
  for (const email of ['a@@b.ru', '@b.ru', 'a@b', 'a@.b.ru', 'a@b.ru.', 'a @b.ru', 'a@b.ru\n'])
    deepStrictEqual(validateCustomer({ ...good, email }), ['email']);
});
test('phone boundaries', () => {
  for (const phone of ['79001234567', '+7900123456', '+790012345678', '8900123456', '890012345678', '+7(900)1234567', '+79001234567\n'])
    deepStrictEqual(validateCustomer({ ...good, phone }), ['phone']);
});
test('fixed error order and no mutation', () => {
  const input = Object.freeze({ ...good, email: 'bad', phone: 'bad' });
  deepStrictEqual(validateCustomer(input), ['email', 'phone']);
  deepStrictEqual(input, { ...good, email: 'bad', phone: 'bad' });
});
