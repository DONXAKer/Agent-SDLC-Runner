/**
 * Валидация покупателя.
 *
 * Счёт выставляется на данные формы заказа как есть; опечатка в email или телефоне
 * узнаётся о себе спустя неделю, когда счёт так и не оплачен. Валидация живёт на
 * стороне выставления, а не формы: форма не знает правил биллинга.
 *
 * Модуль чистый: читает Customer и возвращает список кодов нарушений, ничего не
 * пишет и ничего не меняет. Пустой список — покупатель валиден.
 */

import type { Customer } from './customer.ts';

/** Коды нарушений, в фиксированном порядке. */
export type CustomerIssue = 'email' | 'phone';

/**
 * Проверить email: ровно одна «@»; локальная часть не пустая; домен содержит точку,
 * не начинается и не заканчивается на неё; пробелов нигде нет.
 */
function validEmail(email: string): boolean {
  if (email.includes(' ')) return false;
  if ((email.match(/@/g) ?? []).length !== 1) return false;
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local === '') return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/**
 * Проверить телефон: либо «+7» и ровно 10 цифр после, либо «8» и ровно 10 цифр
 * после. Никаких других символов — пробелов, скобок, дефисов — не допускаем: форма
 * их не ставит.
 */
function validPhone(phone: string): boolean {
  return /^\+7\d{10}$/.test(phone) || /^8\d{10}$/.test(phone);
}

/**
 * Валидация покупателя. Возвращает список кодов нарушений в фиксированном
 * порядке: сначала «email», затем «phone». Пустой список — покупатель валиден.
 */
export function validateCustomer(customer: Customer): CustomerIssue[] {
  const issues: CustomerIssue[] = [];
  if (!validEmail(customer.email)) issues.push('email');
  if (!validPhone(customer.phone)) issues.push('phone');
  return issues;
}
