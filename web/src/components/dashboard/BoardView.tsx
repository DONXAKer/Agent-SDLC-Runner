import { memo, useMemo, useState } from 'react';

import type { DashboardCard, StageId } from '@sdlc-runner/shared';

import { BOARD_COLUMNS, groupBoard } from '../../lib/dashboardBoard.ts';
import type { BoardColumn, BoardPlace } from '../../lib/dashboardBoard.ts';
import { cardKey, isRunningNow } from '../../lib/dashboardSort.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost } from '../../lib/format.ts';
import { CIRCLE, STATE_LABEL, stageGlyph } from '../../lib/stageTone.ts';
import { SourceBadge } from './SourceBadge.tsx';

/** Карточек в столбце за раз: у «Верификации» бывают сотни прогонов стенда. */
const COLUMN_PAGE = 25;

/** Этап без движения дольше этого — подсвечивается как зависший (идущий или брошенный). */
const STALE_MS = 30 * 60_000;

const MiniCard = memo(function MiniCard({
  card,
  place,
  nowMs,
  onOpen,
}: {
  card: DashboardCard;
  place: BoardPlace;
  nowMs: number;
  onOpen: (card: DashboardCard) => void;
}): JSX.Element {
  const stage = place.column === 'done' ? null : card.stages.find((s) => s.id === place.column);
  const age = nowMs - (Date.parse(card.updatedAt) || nowMs);
  // Идущий этап без правок полчаса — скорее всего завис: процесс жив, а лента стоит.
  const stale = place.state === 'running' && age > STALE_MS;
  const live = isRunningNow(card);
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      title={stage?.note ?? undefined}
      className={`w-full rounded border p-2 text-left text-xs transition hover:border-neutral-500 ${
        stale
          ? 'border-amber-700 bg-amber-950/20'
          : live
            ? 'border-emerald-600 bg-emerald-950/30 ring-1 ring-emerald-700/60'
            : 'border-neutral-800 bg-neutral-900/40'
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <SourceBadge source={card.ref.source} />
        {live ? <span className="animate-pulse text-emerald-400" title="идёт сейчас">●</span> : null}
        <span className="min-w-0 truncate font-mono text-[11px]">{card.ref.slug}</span>
      </div>
      <div className="mt-1 truncate text-[11px] text-neutral-500">
        {card.bench !== null ? `${card.bench.task} · ${card.bench.model}` : (card.requirement ?? card.ref.project)}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {card.stages.map((s, i) => (
          <span
            key={s.id}
            className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] ${CIRCLE[s.state]} ${
              s.id === place.column ? 'ring-1 ring-neutral-300' : ''
            }`}
          >
            {stageGlyph(s.state, i)}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[10px]">
        <span className={STATE_LABEL[place.state].cls}>{place.column === 'done' ? 'все этапы закрыты' : STATE_LABEL[place.state].text}</span>
        {card.live !== null && card.live.waiting > 0 ? <span className="text-amber-300">ждёт: {card.live.waiting}</span> : null}
        {stale ? <span className="text-amber-400">нет движения</span> : null}
        <span className="ml-auto text-neutral-500">{fmtUpdatedAt(card.updatedAt, nowMs)}</span>
      </div>
      {stage?.note != null && stage.note !== 'выполняется' ? (
        <div className="mt-1 line-clamp-2 text-[10px] text-neutral-500">{stage.note}</div>
      ) : null}
      {card.usage !== null ? <div className="mt-0.5 text-[10px] text-neutral-600">{fmtCost(card.usage, card.currency)}</div> : null}
    </button>
  );
});

function Column({
  column,
  title,
  items,
  nowMs,
  onOpen,
}: {
  column: BoardColumn;
  title: string;
  items: { card: DashboardCard; place: BoardPlace }[];
  nowMs: number;
  onOpen: (card: DashboardCard) => void;
}): JSX.Element {
  const [limit, setLimit] = useState(COLUMN_PAGE);
  const counts = { running: 0, failed: 0, blocked: 0 };
  for (const { place } of items) {
    if (place.state === 'running' || place.state === 'failed' || place.state === 'blocked') counts[place.state] += 1;
  }
  const shown = items.slice(0, limit);
  return (
    <section className="flex w-64 shrink-0 flex-col rounded border border-neutral-800 bg-neutral-950">
      <header className="border-b border-neutral-800 px-2 py-1.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          {column === 'done' ? (
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${CIRCLE.done}`}>✓</span>
          ) : null}
          <span>{title}</span>
          <span className="ml-auto text-neutral-500">{items.length}</span>
        </div>
        {counts.running + counts.failed + counts.blocked > 0 ? (
          <div className="mt-0.5 flex gap-2 text-[10px]">
            {counts.running > 0 ? <span className={STATE_LABEL.running.cls}>идёт {counts.running}</span> : null}
            {counts.failed > 0 ? <span className={STATE_LABEL.failed.cls}>провал {counts.failed}</span> : null}
            {counts.blocked > 0 ? <span className={STATE_LABEL.blocked.cls}>стоит {counts.blocked}</span> : null}
          </div>
        ) : null}
      </header>
      <div className="flex max-h-[calc(100vh-14rem)] flex-col gap-1.5 overflow-y-auto p-1.5">
        {shown.map(({ card, place }) => (
          <MiniCard key={cardKey(card.ref)} card={card} place={place} nowMs={nowMs} onOpen={onOpen} />
        ))}
        {items.length === 0 ? <div className="px-1 py-2 text-[11px] text-neutral-600">пусто</div> : null}
        {items.length > shown.length ? (
          <button
            type="button"
            onClick={() => setLimit((l) => l + COLUMN_PAGE)}
            className="rounded border border-neutral-800 py-1 text-[11px] text-neutral-400 hover:bg-neutral-900"
          >
            ещё {Math.min(COLUMN_PAGE, items.length - shown.length)} из {items.length - shown.length}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Доска: столбец на этап. Порядок внутри столбца — тот же, что у списка (ждущие → идущие →
 * свежие), поэтому зависшее и требующее человека оказывается сверху своего этапа.
 */
export function BoardView({
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
  // Раскладка — только при смене списка: объекты `place` новые на каждую раскладку, и
  // пересчёт на каждом рендере ломал `memo` мини-карточек.
  const groups = useMemo(() => groupBoard(cards), [cards]);
  return (
    <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
      {BOARD_COLUMNS.map((col) => (
        <Column
          key={col}
          column={col}
          title={col === 'done' ? 'Передан / всё закрыто' : (titles[col] ?? col)}
          items={groups[col]}
          nowMs={nowMs}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
