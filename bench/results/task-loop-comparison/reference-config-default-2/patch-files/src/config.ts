/**
 * Конфигурация биллинга.
 *
 * Всё, что меняется между площадками, живёт здесь, а не размазано по коду. Читается через
 * resolveConfig: прямое обращение к DEFAULT_CONFIG из модулей запрещено — иначе переопределение
 * конфига молча перестаёт действовать на половину мест.
 */

export interface BillingConfig {
  /** Валюта счетов. Других у нас нет, но поле есть: отчётность её читает. */
  currency: 'RUB';
  /** Срок оплаты в днях, если вызов не задаёт свой. */
  defaultDueDays: number;
}

export const DEFAULT_CONFIG: BillingConfig = {
  currency: 'RUB',
  defaultDueDays: 14,
};

/** Конфиг с переопределениями площадки. Не указанное — из DEFAULT_CONFIG. */
export function resolveConfig(partial?: Partial<BillingConfig>): BillingConfig {
  return { ...DEFAULT_CONFIG, ...partial, defaultDueDays: partial?.defaultDueDays ?? DEFAULT_CONFIG.defaultDueDays };
}
