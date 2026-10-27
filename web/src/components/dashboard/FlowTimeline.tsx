import type { DashboardCard, StageId } from '@sdlc-runner/shared';

import { focusStage, formatStageSummary, stageSummary } from '../../lib/dashboardStages.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost } from '../../lib/format.ts';
import { hasFailedStage, isWaitingForHuman } from '../../lib/flowTimeline.ts';
import { historyStatusLabel, historyStatusTone } from '../../lib/historyStatus.ts';
import { isRunningNow } from '../../lib/dashboardSort.ts';
import { SourceBadge } from './SourceBadge.tsx';
import { StageStrip } from './StageStrip.tsx';

export function FlowTimeline({
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
  return (
    <ol className="relative ml-2 mt-5 space-y-4 border-l border-neutral-800 pl-6">
      {cards.map((card) => {
        const failed = card.status === 'aborted' || hasFailedStage(card);
        const running = isRunningNow(card);
        const waiting = isWaitingForHuman(card);
        const focus = focusStage(card.stages);
        const dot = failed ? 'border-red-700 bg-red-950' : waiting ? 'border-amber-600 bg-amber-950' : running ? 'border-emerald-600 bg-emerald-950' : 'border-neutral-700 bg-neutral-950';
        return (
          <li key={`${card.ref.source}/${card.ref.project}/${card.ref.slug}`} className="relative">
            <span aria-hidden="true" className={`absolute -left-[31px] top-6 h-2.5 w-2.5 rounded-full border-2 ${dot}`} />
            <button
              type="button"
              onClick={() => onOpen(card)}
              className={`block w-full rounded-lg border bg-neutral-950 p-4 text-left transition hover:bg-neutral-900/70 ${failed ? 'border-red-900 hover:border-red-700' : 'border-neutral-800 hover:border-neutral-600'}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <SourceBadge source={card.ref.source} />
                <span className="min-w-0 truncate font-mono text-sm">
                  <span className="text-neutral-500">{card.ref.project} · </span>{card.ref.slug}
                </span>
                <span className={`rounded border px-1.5 py-px text-[10px] ${historyStatusTone(card.status)}`}>{historyStatusLabel(card.status)}</span>
                {waiting ? <span className="rounded border border-amber-700 px-1.5 py-px text-[10px] text-amber-300">ждёт человека</span> : running ? <span className="text-xs text-emerald-400">● работает</span> : null}
                <span className="ml-auto text-[11px] text-neutral-500">{fmtUpdatedAt(card.updatedAt, nowMs)}</span>
              </div>
              {card.requirement !== undefined ? <div className="mt-2 line-clamp-2 text-sm text-neutral-300">{card.requirement}</div> : null}
              {card.bench !== null ? <div className="mt-2 truncate text-xs text-neutral-400">задача <span className="font-mono">{card.bench.task}</span> · модель <span className="font-mono">{card.bench.model}</span></div> : null}
              <div className="mt-3"><StageStrip stages={card.stages} /></div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span className={failed ? 'text-red-300' : 'text-neutral-400'}>{formatStageSummary(stageSummary(card.stages), titles)}</span>
                <span className="text-neutral-500">chunk {card.chunk} · попытка {card.attempt}</span>
                {card.usage !== null ? <span className="text-neutral-500">{fmtCost(card.usage, card.currency)}</span> : null}
              </div>
              {focus?.note != null ? <div className={`mt-2 whitespace-pre-wrap break-words rounded px-2 py-1.5 text-xs ${failed ? 'bg-red-950/30 text-red-200' : 'bg-neutral-900 text-neutral-400'}`}>{focus.title}: {focus.note}</div> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
