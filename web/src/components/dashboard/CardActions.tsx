import type { MouseEvent } from 'react';

import type { DashboardCard } from '@sdlc-runner/shared';

import { BTN_SECONDARY } from '../../lib/tones.ts';

/**
 * Переходы с карточки: на страницу живого витка и в его архивную ленту. Одна разметка на
 * сетку и детальную карточку — условия показа двух кнопок не должны разойтись между ними.
 * Ленту на диске пишет только раннер: у терминального витка и прогона стенда её нет.
 */
export function CardActions({
  card,
  className,
  onOpenLive,
  onOpenArchive,
}: {
  card: DashboardCard;
  className: string;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
}): JSX.Element | null {
  const live = card.live;
  const hasArchive = card.ref.source === 'ui';
  if (live === null && !hasArchive) return null;
  // Клик по кнопке не открывает детали карточки, в которую она вложена.
  const stop = (e: MouseEvent): void => e.stopPropagation();
  return (
    <div className={className} onClick={stop}>
      {live !== null ? (
        <button
          type="button"
          onClick={() => onOpenLive(live.runId)}
          className="rounded border border-emerald-800 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-950/40"
        >
          открыть живой виток
        </button>
      ) : null}
      {hasArchive ? (
        <button type="button" onClick={() => onOpenArchive(card.ref.project, card.ref.slug)} className={`${BTN_SECONDARY} px-2 py-0.5 text-xs`}>
          лента событий
        </button>
      ) : null}
    </div>
  );
}
