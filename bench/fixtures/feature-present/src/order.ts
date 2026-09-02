/**
 * Заказ.
 *
 * Сумма позиций приходит уже посчитанной (в копейках): состав корзины — дело каталога, а
 * здесь решается только, сколько с клиента взять. Порядок закреплён: сумма позиций →
 * скидка от неё → вычитание. Скидка не может увести итог ниже нуля — это `subtract`.
 */

import type { Account } from './loyalty.ts';
import { loyaltyDiscount } from './loyalty.ts';
import type { Kopeck } from './money.ts';
import { subtract } from './money.ts';

/** Сумма к оплате: позиции минус накопительная скидка клиента. */
export function orderTotal(account: Account, itemsK: Kopeck): Kopeck {
  return subtract(itemsK, loyaltyDiscount(account, itemsK));
}
