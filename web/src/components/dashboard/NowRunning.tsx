import type { DashboardCard, StageId } from '@sdlc-runner/shared';

import { cardKey, isRunningNow } from '../../lib/dashboardSort.ts';
import { focusStage } from '../../lib/dashboardStages.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost } from '../../lib/format.ts';
import { STATE_LABEL } from '../../lib/stageTone.ts';
import { SourceBadge } from './SourceBadge.tsx';
import { StageStrip } from './StageStrip.tsx';

/**
 * Полоса «Сейчас идёт» над доской и сеткой: идущее не должно искаться глазами по столбцам
 * среди сотен законченных карточек. Берётся из ВСЕГО списка, а не из отфильтрованного:
 * фильтр, забытый с прошлого захода, не должен прятать то, что крутится прямо сейчас.
 */
export function NowRunning({
  cards,
  titles,
  nowMs,
  onOpen,
}: {
  cards: readonly DashboardCard[];
  titles: Partial<Record<StageId, string>>;
  nowMs: number;
  onOpen: (card: DashboardCard) => void;
}): JSX.Element {
  const running = cards.filter(isRunningNow);
  if (running.length === 0) {
    return <div className="mt-3 text-xs text-neutral-600">сейчас ничего не идёт</div>;
  }
  return (
    <section className="mt-3 rounded-lg border border-emerald-700/70 bg-emerald-950/20 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-300">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
        Сейчас идёт · {running.length}
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
        {running.map((c) => {
          const focus = focusStage(c.stages);
          const waiting = c.live?.waiting ?? 0;
          return (
            <button
              key={cardKey(c.ref)}
              type="button"
              onClick={() => onOpen(c)}
              className="rounded border border-emerald-800 bg-neutral-950/80 p-2.5 text-left transition hover:border-emerald-500"
            >
              <div className="flex min-w-0 items-center gap-2">
                <SourceBadge source={c.ref.source} />
                <span className="min-w-0 truncate font-mono text-sm text-neutral-100">{c.ref.slug}</span>
                <span className="ml-auto shrink-0 text-[11px] text-neutral-500">{fmtUpdatedAt(c.updatedAt, nowMs)}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-400">
                {c.bench !== null ? `${c.bench.model} · ${c.bench.task}` : `${c.ref.project}${c.requirement === undefined ? '' : ` · ${c.requirement}`}`}
              </div>
              <div className="mt-2">
                <StageStrip stages={c.stages} {...(focus === null ? {} : { selected: focus.id })} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs">
                {focus !== null ? (
                  <span className={STATE_LABEL[focus.state].cls}>
                    {titles[focus.id] ?? focus.id}: {STATE_LABEL[focus.state].text}
                  </span>
                ) : null}
                <span className="text-neutral-500">
                  chunk {c.chunk} · попытка {c.attempt}
                </span>
                {waiting > 0 ? <span className="text-amber-300">ждёт человека: {waiting}</span> : null}
                {c.usage !== null ? <span className="ml-auto text-neutral-500">{fmtCost(c.usage, c.currency)}</span> : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
