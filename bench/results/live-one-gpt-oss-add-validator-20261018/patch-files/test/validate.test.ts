import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateCustomer } from '../src/validate.ts';

describe('validateCustomer', () => {
  const valid = { email: 'user@example.com', phone: '+79001234567' };

  it('valid data returns empty array', () => {
    strictEqual(JSON.stringify(validateCustomer(valid)), JSON.stringify([]));
  });

  it('invalid email adds "email" code', () => {
    const res = validateCustomer({ ...valid, email: 'bad@com' });
    strictEqual(res.length, 1);
    strictEqual(res[0], 'email');
  });

  it('invalid phone adds "phone" code', () => {
    const res = validateCustomer({ ...valid, phone: '+123456' });
    strictEqual(res.length, 1);
    strictEqual(res[0], 'phone');
  });

  it('both invalid returns ["email", "phone"] in order', () => {
    const res = validateCustomer({ email: 'bad@com', phone: '+123' });
    strictEqual(JSON.stringify(res), JSON.stringify(['email', 'phone']));
  });
});
