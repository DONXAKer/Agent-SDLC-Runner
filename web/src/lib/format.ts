/**
 * Форматирование чисел прогона.
 *
 * Живёт отдельно от компонентов, потому что одни и те же величины показываются на трёх
 * поверхностях сразу — шапка витка, список витков и лента событий, — а один и тот же
 * формат обязан рендериться одинаково везде. Пока форматтеры лежали внутри `CostBar`,
 * лента печатала `92000 мс` и `$0.0000` там, где шапка показывала `1 мин 32 с` и `$0`.
 */

import type { Usage } from '@sdlc-runner/shared';
import { formatCost, formatDuration } from '@sdlc-runner/shared';

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Правило одно на кодовую базу и живёт в общем пакете: его читает и интерфейс, и
// пост-виток отчёт в `handoff.md`.
export const fmtCost = (usage: Usage): string => formatCost(usage);
export const fmtDuration = formatDuration;

/**
 * Возраст ожидания решения. Грубее `fmtDuration` намеренно: секунды здесь — шум,
 * который заставлял бы строку мигать при каждом тике таймера.
 */
export function fmtWaitedFor(createdAt: number, now: number): string {
  const min = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}
