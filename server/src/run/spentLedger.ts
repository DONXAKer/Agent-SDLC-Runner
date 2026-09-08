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

// Типы этапов, а не голые строки: опечатка в имени этапа тихо выводила бы этап
// из-под бюджетного гарда, а отказ выглядел бы как отсутствие расхода (ревью).
import type { StageId } from '@sdlc-runner/shared';

/**
 * Копится ли расход этого этапа в бюджетный гард.
 *
 * `null` (прод) — да, для любого этапа: бюджет там стережёт деньги проекта, и неважно,
 * какой этап их тратит. Сужается стендом: он измеряет ОДИН этап, остальные идут
 * контрольным маршрутом на сильной модели, и её стоимость закрывала прогон бесплатной
 * локальной модели — измеряемая при `costUsd === null` не тратила ничего, а виток вставал
 * на «бюджет прогона исчерпан: $8.1476 из $5.0000», потраченные чужим рецензентом.
 *
 * Сужается только то, по чему гард рубит виток: в счёт прогона и в события расход
 * попадает всегда, иначе отчёт врал бы о стоимости.
 */
export function countsTowardBudget(
  budgetStages: ReadonlySet<StageId> | null,
  stage: StageId,
): boolean {
  return budgetStages === null || budgetStages.has(stage);
}

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

  /**
   * Снимок сумм для персиста — виток переживает пересоздание `Run`, и бюджетный гард
   * обязан пережить его вместе с ним. Пока сумм не было в снапшоте, рестарт сервиса
   * обнулял `spentUsdBefore`, и виток получал полный `maxBudgetUsd` заново.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.sums);
  }

  /** Восстановление снимка: своё поверх чужого не складывается — начинают с нуля. */
  restore(sums: Record<string, unknown>): void {
    this.sums.clear();
    for (const [currency, value] of Object.entries(sums)) {
      if (typeof value === 'number' && Number.isFinite(value)) this.sums.set(currency, value);
    }
  }
}
