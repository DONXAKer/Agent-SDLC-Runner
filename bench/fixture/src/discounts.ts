/**
 * Скидка лояльности.
 *
 * Скидка считается ОТ БАЗОВОЙ ЦЕНЫ ЗОНЫ и ни от чего другого. Соблазн считать её от
 * итоговой суммы возникает каждый раз, когда в расчёт добавляют новое слагаемое, и
 * каждый раз это меняет цену задним числом всем действующим договорам: клиент со
 * скидкой 12% начинает получать 12% и от чужой надбавки тоже.
 */

import { percent, subtract } from './money.ts';
import type { Kopeck } from './money.ts';

export type Tier = 'none' | 'silver' | 'gold';

export interface Customer {
  id: string;
  tier: Tier;
}

/** Процент скидки по уровню. Меняется только вместе с публичной офертой. */
const TIER_PCT: Record<Tier, number> = {
  none: 0,
  silver: 5,
  gold: 12,
};

/**
 * Потолок скидки.
 *
 * Формально ни один уровень до него не достаёт, и потолок выглядит мёртвым кодом. Он не
 * мёртвый: акционные уровни заводились дважды, оба раза временно, и оба раза потолок был
 * единственным, что удержало цену доставки выше нуля.
 */
const CAP_PCT = 30;

/**
 * Скидка в копейках от базовой цены.
 *
 * Возвращается именно скидка, а не цена со скидкой: вычитать должен тот, кто собирает
 * итог, иначе порядок слагаемых оказывается размазан по двум модулям.
 */
export function discountFor(customer: Customer, base: Kopeck): Kopeck {
  const pct = TIER_PCT[customer.tier];
  const byTier = percent(base, pct);
  const cap = percent(base, CAP_PCT);
  return byTier > cap ? cap : byTier;
}

/** Цена после скидки — тонкая обёртка для вызывающих, которым не нужен размер скидки. */
export function applyDiscount(customer: Customer, base: Kopeck): Kopeck {
  return subtract(base, discountFor(customer, base));
}

/** Уровень без скидки — значение по умолчанию для разовых отправлений. */
export const ANONYMOUS: Customer = { id: 'anonymous', tier: 'none' };
