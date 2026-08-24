import type { RunDetail } from '@sdlc-runner/shared';

import { fmtCost } from '../../lib/format.ts';
import { redCountTone } from '../../lib/tones.ts';

/**
 * Сводка витка в одну строку: суть с первого взгляда, без перехода на вкладку «Метрики».
 *
 * Собрана из `detail.metrics`, который уже приходит с сервера в `RunDetail`, но до этого
 * нигде не рендерился — оператор не мог увидеть ни стоимость по этапам, ни долю красных
 * вердиктов, ни то, сколько попыток съел текущий chunk, не читая ленту событий вручную.
 */
export function RunSummaryStrip({ detail }: { detail: RunDetail }): JSX.Element | null {
  const { verdicts, attemptsByChunk } = detail.metrics;
  const currentChunkAttempts = attemptsByChunk.find((a) => a.chunk === detail.chunk)?.attempts ?? null;
  // Деньги на intent/explore/ask/plan тратятся раньше первого вердикта и первой
  // попытки chunk — гейт по одним только `verdicts`/`attemptsByChunk` прятал бы
  // единственную строку про стоимость именно тогда, когда она уже не ноль.
  const hasUsage = detail.usage.inputTokens > 0 || detail.usage.outputTokens > 0;

  if (verdicts.total === 0 && currentChunkAttempts === null && !hasUsage) return null;

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-neutral-900 bg-neutral-950/60 px-4 py-1.5 text-xs text-neutral-400">
      <span>Стоимость витка: {fmtCost(detail.usage)}</span>
      {verdicts.total > 0 ? (
        <span className={redCountTone(verdicts.red)}>
          Вердиктов: {verdicts.total}, из них красных {verdicts.red}
        </span>
      ) : null}
      {currentChunkAttempts !== null ? (
        <span>
          Попыток в chunk {detail.chunk}: {currentChunkAttempts} из {detail.attemptBudget}
        </span>
      ) : null}
    </div>
  );
}
