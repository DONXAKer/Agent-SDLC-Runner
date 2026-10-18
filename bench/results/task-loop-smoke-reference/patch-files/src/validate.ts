import type { Customer } from './customer.ts';

/** Проверить контактные данные без изменения покупателя. */
export function validateCustomer(customer: Customer): string[] {
  const errors: string[] = [];
  const parts = customer.email.split('@');
  const [local, domain] = parts;
  if (parts.length !== 2 || !local || !domain || /\s/u.test(customer.email) ||
      !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    errors.push('email');
  }
  if (!/^(?:\+7|8)[0-9]{10}$/u.test(customer.phone) || /\s/u.test(customer.phone)) errors.push('phone');
  return errors;
}
