/**
 * Ежемесячный отчёт по клиентам.
 *
 * Отчёт читают люди и выгрузка в бухгалтерию, поэтому его формат — контракт: шапка, потом
 * по строке на клиента, колонки через ` | `. Колонка «Скидка» появилась вместе с
 * накопительной скидкой — бухгалтерии нужно видеть, кому какая ставка действует.
 */

import type { Account } from './loyalty.ts';
import { loyaltyRate } from './loyalty.ts';
import { formatRub } from './money.ts';

/** Шапка отчёта — первая строка, всегда одна и та же. */
export const REPORT_HEADER = 'Клиент | Покупки | Скидка';

/** Строка клиента: идентификатор, сумма покупок за всё время, действующая ставка скидки. */
export function reportLine(account: Account): string {
  return `${account.id} | ${formatRub(account.spentTotalK)} | ${loyaltyRate(account)} %`;
}

/** Отчёт целиком: шапка и строки клиентов в порядке, в котором их передали. */
export function monthlyReport(accounts: readonly Account[]): string {
  return [REPORT_HEADER, ...accounts.map(reportLine)].join('\n');
}
