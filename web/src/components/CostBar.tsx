import type { Usage } from '@sdlc-runner/shared';

import { fmtCost, fmtDuration, fmtTokens } from '../lib/format.ts';

export function CostBar({ usage, budgetUsd }: { usage: Usage; budgetUsd: number }): JSX.Element {
  const over = usage.costUsd !== null && usage.costUsd >= budgetUsd;

  return (
    <div className="flex items-center gap-4 text-xs text-neutral-400">
      <span title="токены на вход">↑ {fmtTokens(usage.inputTokens)}</span>
      <span title="токены на выход">↓ {fmtTokens(usage.outputTokens)}</span>
      <span title="чтение кэша">кэш {fmtTokens(usage.cacheReadTokens)}</span>
      <span className={over ? 'font-medium text-red-400' : 'text-neutral-300'}>
        {fmtCost(usage)}
        {over ? ` / бюджет $${budgetUsd}` : ''}
      </span>
      <span>{fmtDuration(usage.durationMs)}</span>
    </div>
  );
}
