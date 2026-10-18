/**
 * Валидация покупателя.
 *
 * Счёт выставляется на данные формы заказа как есть; опечатка в email или телефоне
 * узнаётся о себе, когда счёт так и не оплачен. Поэтому на выставлении данные
 * проверяются здесь, а не в форме (форма не знает правил биллинга).
 *
 * Функция чистая: ничего не пишет и ничего не меняет. Возвращает список кодов
 * нарушений; пустой список — покупатель валиден. Коды и их порядок фиксированы:
 * сначала 'email', затем 'phone'.
 */

import type { Customer } from './customer.ts';

/** Проверить email: ровно одна @, локальная часть непустая, домен с точкой,
 *  не начинается и не заканчивается на неё, пробелов нигде нет. */
function emailValid(email: string): boolean {
  if (email.includes(' ')) return false;
  const at = email.indexOf('@');
  if (at === -1 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0) return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/** Проверить телефон: либо +7 и ровно 10 цифр после, либо 8 и ровно 10 цифр после.
 *  Никаких других символов (пробелов, скобок, дефисов) не допускаем — форма их не ставит. */
function phoneValid(phone: string): boolean {
  return /^\+7\d{10}$/.test(phone) || /^8\d{10}$/.test(phone);
}

/**
 * Проверить покупателя.
 *
 * @returns список кодов нарушений; пустой список — покупатель валиден.
 *   Порядок кодов фиксирован: сначала 'email', затем 'phone'.
 */
export function validateCustomer(customer: Customer): string[] {
  const violations: string[] = [];
  if (!emailValid(customer.email)) violations.push('email');
  if (!phoneValid(customer.phone)) violations.push('phone');
  return violations;
}
