/**
 * Форматирование чисел прогона.
 *
 * Живёт отдельно от компонентов, потому что одни и те же величины показываются на трёх
 * поверхностях сразу — шапка витка, список витков и лента событий, — а один и тот же
 * формат обязан рендериться одинаково везде. Пока форматтеры лежали внутри `CostBar`,
 * лента печатала `92000 мс` и `$0.0000` там, где шапка показывала `1 мин 32 с` и `$0`.
 */

import type { Usage } from '@sdlc-runner/shared';

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * Ноль стоимости означает разное, и путать эти случаи нельзя: до первого вызова модели
 * тратить ещё нечего, а на локальном маршруте стоимости нет вовсе.
 *
 * «Ещё нечего» — это ноль стоимости ПРИ полном отсутствии токенов, включая кэшевые.
 * Пока признак считался только по `input + output`, вызов, у которого стоимость есть, а
 * этих двух счётчиков нет (расход посчитан провайдером без разбивки), показывался как
 * «—» — то есть реальные деньги выглядели как «расхода не было».
 */
export function fmtCost(usage: Usage): string {
  if (usage.costUsd === null) return 'без стоимости';
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (usage.costUsd === 0 && tokens === 0) return '—';
  if (usage.costUsd === 0) return '$0';
  return `$${usage.costUsd.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}
