import type { Usage } from '../lib/types.ts';

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * Ноль стоимости означает разное, и путать эти случаи нельзя: до первого вызова модели
 * тратить ещё нечего, а на локальном маршруте стоимости нет вовсе. Отличаем по тому,
 * были ли вообще токены.
 */
function fmtCost(c: number | null, anyTokens: boolean): string {
  if (c === null) return 'без стоимости';
  if (!anyTokens) return '—';
  if (c === 0) return '$0';
  return `$${c.toFixed(4)}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

export function CostBar({ usage, budgetUsd }: { usage: Usage; budgetUsd: number }): JSX.Element {
  const anyTokens = usage.inputTokens + usage.outputTokens > 0;
  const over = usage.costUsd !== null && usage.costUsd >= budgetUsd;

  return (
    <div className="flex items-center gap-4 text-xs text-neutral-400">
      <span title="токены на вход">↑ {fmtTokens(usage.inputTokens)}</span>
      <span title="токены на выход">↓ {fmtTokens(usage.outputTokens)}</span>
      <span title="чтение кэша">кэш {fmtTokens(usage.cacheReadTokens)}</span>
      <span className={over ? 'font-medium text-red-400' : 'text-neutral-300'}>
        {fmtCost(usage.costUsd, anyTokens)}
        {over ? ` / бюджет $${budgetUsd}` : ''}
      </span>
      <span>{fmtDuration(usage.durationMs)}</span>
    </div>
  );
}
