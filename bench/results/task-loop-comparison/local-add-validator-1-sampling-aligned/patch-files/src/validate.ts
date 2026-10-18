/**
 * Валидация покупателя.
 *
 * Данные формы заказа приходят как есть — опечатка в email или телефоне иначе узнаётся
 * через неделю, когда счёт не оплачен. Поэтому на выставлении проверяем контактные данные
 * и перечисляем, что не так.
 *
 * Реализация намеренно не встроена в buildInvoice: встроить проверку в сборку счёта —
 * отдельное решение, здесь покупатель просто проверяется по правилам.
 */

import type { Customer } from './customer.ts';

/** Код нарушения: сначала email, затем phone; порядок фиксирован. */
export type Violation = 'email' | 'phone';

/** Email валиден: ровно одна @, локальная часть непустая, домен с точкой в середине и без
 *  пробелов нигде. */
function validEmail(email: string): boolean {
  if (email.indexOf(' ') !== -1) return false;
  const at = email.indexOf('@');
  if (at === -1 || email.lastIndexOf('@') !== at) return false;
  const local = email.slice(0, at);
  if (local.length === 0) return false;
  const domain = email.slice(at + 1);
  if (domain.length === 0 || domain.length < 3) return false;
  if (domain.indexOf('.') === -1) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/** Телефон валиден: либо +7 и ровно 10 цифр после, либо 8 и ровно 10 цифр после —
 *  других символов не допускаем, форма их не ставит. */
function validPhone(phone: string): boolean {
  return /^\+7\d{10}$/.test(phone) || /^8\d{10}$/.test(phone);
}

/** Проверить покупателя и вернуть список кодов нарушений; пустой список — покупатель валиден. */
export function validateCustomer(customer: Customer): Violation[] {
  const violations: Violation[] = [];
  if (!validEmail(customer.email)) violations.push('email');
  if (!validPhone(customer.phone)) violations.push('phone');
  return violations;
}
