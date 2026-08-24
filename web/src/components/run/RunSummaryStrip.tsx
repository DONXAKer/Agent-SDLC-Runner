import type { RunDetail } from '@sdlc-runner/shared';

import { redCountTone } from '../../lib/tones.ts';

/**
 * Сводка витка в одну строку: суть с первого взгляда, без перехода на вкладку «Метрики».
 *
 * Только доля красных вердиктов — единственное здесь, чего не показывает `RunHeader` над
 * ней. Стоимость (`CostBar`) и «chunk N · попытка X из Y» там уже есть; дублировать их
 * тут второй строкой с той же цифрой означало бы держать одно число в двух местах.
 */
export function RunSummaryStrip({ detail }: { detail: RunDetail }): JSX.Element | null {
  const { verdicts } = detail.metrics;
  if (verdicts.total === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-neutral-900 bg-neutral-950/60 px-4 py-1.5 text-xs text-neutral-400">
      <span className={redCountTone(verdicts.red)}>
        Вердиктов: {verdicts.total}, из них красных {verdicts.red}
      </span>
    </div>
  );
}
