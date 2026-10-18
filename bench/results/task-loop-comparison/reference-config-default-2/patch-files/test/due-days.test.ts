import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { bill, buildInvoice, resolveConfig } from '../src/index.ts';
const customer = { name: 'Иван', email: 'a@b.ru', phone: '+79001234567' };
test('default and override precedence', () => {
  strictEqual(bill('1', customer, []).dueDays, 14);
  strictEqual(bill('2', customer, [], { defaultDueDays: 30 }).dueDays, 30);
  strictEqual(bill('3', customer, [], { defaultDueDays: 30 }, { dueDays: 7 }).dueDays, 7);
  strictEqual(bill('4', customer, [], undefined, { dueDays: 0 }).dueDays, 0);
  strictEqual(bill('5', customer, [], { defaultDueDays: 0 }).dueDays, 0);
  strictEqual(bill('6', customer, [], { defaultDueDays: undefined }).dueDays, 14);
  strictEqual(buildInvoice('7', customer, [], { defaultDueDays: 21 }).dueDays, 21);
});
test('resolveConfig preserves caller input and currency', () => {
  const input = Object.freeze({ defaultDueDays: 9 });
  deepStrictEqual(resolveConfig(input), { currency: 'RUB', defaultDueDays: 9 });
  deepStrictEqual(input, { defaultDueDays: 9 });
});
