/**
 * Валидация покупателя на момент выставления счёта.
 *
 * Счёт выставляется на данные формы заказа как есть; опечатка в email или телефоне
 * узнаётся о себе только когда счёт не оплачен. Поэтому данные проверяются здесь,
 * на выставлении, а не в форме (форма не знает правил биллинга).
 *
 * Функция чистая: ничего не пишет и ничего не меняет — возвращает список кодов
 * нарушений. Пустой список — покупатель валиден. Коды и их порядок фиксированы:
 * сначала 'email', затем 'phone'.
 */

import type { Customer } from './customer.ts';

/** Проверить email: ровно одна '@', локальная часть непустая, домен содержит точку
 *  и не начинается и не заканчивается на неё, пробелов нигде нет. */
function emailViolations(email: string): boolean {
  if (email.includes(' ')) return true;
  const atCount = email.split('@').length - 1;
  if (atCount !== 1) return true;
  const [local, domain] = email.split('@');
  if (local.length === 0) return true;
  if (!domain.includes('.')) return true;
  if (domain.startsWith('.') || domain.endsWith('.')) return true;
  return false;
}

/** Проверить телефон: либо '+7' и ровно 10 цифр после, либо '8' и ровно 10 цифр после.
 *  Никаких других символов (пробелов, скобок, дефисов) не допускаем — форма их не ставит. */
function phoneViolations(phone: string): boolean {
  return /^\+7\d{10}$/.test(phone) || /^8\d{10}$/.test(phone) ? false : true;
}

/**
 * Валидировать покупателя.
 *
 * @returns список кодов нарушений в фиксированном порядке: сначала 'email', затем 'phone'.
 *          Пустой список — покупатель валиден.
 */
export function validateCustomer(customer: Customer): string[] {
  const violations: string[] = [];
  if (emailViolations(customer.email)) violations.push('email');
  if (phoneViolations(customer.phone)) violations.push('phone');
  return violations;
}
