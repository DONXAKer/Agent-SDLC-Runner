/**
 * Потраченное по валютам — учёт для бюджетного гарда.
 *
 * `Usage.costUsd` называется долларами исторически: `usage.cost` OpenAI-совместимых
 * провайдеров приходит ЧИСЛОМ В ВАЛЮТЕ СВОЕГО ПРОВАЙДЕРА (у polza — рубли, см.
 * `ProviderDef.currency` и `ProjectConfig.maxBudgetUsd`). Складывать такие числа
 * друг с другом нельзя: в смешанном профиле «рубли + доллары» давали сумму, которую
 * гард каждого маршрута верно сравнивал с потолком и неверно — по существу.
 *
 * Поэтому учёт ведётся отдельно на каждую валюту, и маршрут сверяет бюджет только
 * с той суммой, что потрачена в ЕГО валюте.
 */

export class SpentLedger {
  private readonly sums = new Map<string, number>();

  /** Прибавить фактическую стоимость хода. `null` (локальный провайдер без цены) — пропуск. */
  add(currency: string, cost: number | null): void {
    if (cost === null) return;
    this.sums.set(currency, (this.sums.get(currency) ?? 0) + cost);
  }

  /** Сколько потрачено в данной валюте. Неизвестная валюта — ноль, не `undefined`. */
  spent(currency: string): number {
    return this.sums.get(currency) ?? 0;
  }
}
