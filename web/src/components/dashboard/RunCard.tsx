import { memo } from 'react';
import type { KeyboardEvent } from 'react';

import type { DashboardCard, StageId } from '@sdlc-runner/shared';

import { formatStageSummary, stageSummary } from '../../lib/dashboardStages.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost } from '../../lib/format.ts';
import { historyStatusLabel, historyStatusTone } from '../../lib/historyStatus.ts';
import { statusLabel } from '../../lib/runStatus.ts';
import { verdictTextTone } from '../../lib/tones.ts';
import { ArtifactChips } from './ArtifactChips.tsx';
import { CardActions } from './CardActions.tsx';
import { SourceBadge } from './SourceBadge.tsx';
import { StageStrip } from './StageStrip.tsx';

/**
 * Карточка запуска в сетке дашборда. Вся карточка — кнопка открытия деталей; внутренние
 * кнопки («живой виток», «лента») гасят всплытие, иначе клик по ним открывал бы и детали.
 * `div role=button`, а не `button`: кнопку в кнопку вкладывать нельзя.
 *
 * `memo`: опрос раз в пять секунд пересобирает список из сотен карточек, а меняются из
 * них единицы — неизменная карточка приходит тем же объектом (сервер кэширует, клиент
 * не разбирает неизменный список по метке ETag) и не перерисовывается.
 */
export const RunCard = memo(function RunCard({
  card,
  titles,
  nowMs,
  onOpen,
  onOpenLive,
  onOpenArchive,
}: {
  card: DashboardCard;
  titles: Partial<Record<StageId, string>>;
  nowMs: number;
  onOpen: (card: DashboardCard) => void;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
}): JSX.Element {
  const summary = stageSummary(card.stages);
  const onKey = (e: KeyboardEvent): void => {
    // Только клавиша на самой карточке: Enter на внутренней кнопке («живой виток», «лента»)
    // всплывал сюда, `preventDefault` отменял нажатие кнопки, и открывалась деталь.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(card);
    }
  };
  const verdict = card.bench?.finalVerdict ?? null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card)}
      onKeyDown={onKey}
      className="flex cursor-pointer flex-col gap-2 rounded border border-neutral-800 p-3 text-sm transition hover:border-neutral-600 hover:bg-neutral-900/60"
    >
      <div className="flex min-w-0 items-center gap-2">
        <SourceBadge source={card.ref.source} />
        <span className="min-w-0 truncate font-mono text-xs" title={`${card.ref.project} · ${card.ref.slug}`}>
          <span className="text-neutral-500">{card.ref.project} · </span>
          {card.ref.slug}
        </span>
        <span className={`ml-auto shrink-0 rounded border px-1.5 py-px text-[10px] ${historyStatusTone(card.status)}`}>
          {historyStatusLabel(card.status)}
        </span>
      </div>

      {card.live !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-emerald-400">● живой</span>
          <span className="text-neutral-400">
            {card.live.stage === null ? `этап: ${statusLabel(card.live.status, null)}` : `выполняется ${titles[card.live.stage] ?? card.live.stage}`}
          </span>
          {card.live.waiting > 0 ? (
            <span className="rounded border border-amber-700 px-1.5 text-amber-300">ждёт: {card.live.waiting}</span>
          ) : null}
        </div>
      ) : null}

      {card.bench?.inProgress === true ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-emerald-400">● идёт прогон стенда</span>
          {(() => {
            const now = card.stages.find((s) => s.state === 'running');
            return now === undefined ? null : <span className="text-neutral-400">выполняется {titles[now.id] ?? now.id}</span>;
          })()}
        </div>
      ) : null}

      {card.requirement !== undefined ? <div className="line-clamp-2 text-xs text-neutral-400">{card.requirement}</div> : null}
      {card.bench !== null ? (
        <div className="truncate text-xs text-neutral-400" title={`${card.bench.task} · ${card.bench.model}`}>
          задача <span className="font-mono text-neutral-300">{card.bench.task}</span> · модель{' '}
          <span className="font-mono text-neutral-300">{card.bench.model}</span>
          {card.bench.mode.kind === 'stage' ? <span className="text-neutral-500"> · замер {titles[card.bench.mode.stage] ?? card.bench.mode.stage}</span> : null}
        </div>
      ) : null}

      <StageStrip stages={card.stages} />

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
        <span>{formatStageSummary(summary, titles)}</span>
        {card.chunk > 1 || card.attempt > 1 ? <span>chunk {card.chunk} · попытка {card.attempt}</span> : null}
        {card.usage !== null ? <span>{fmtCost(card.usage, card.currency)}</span> : null}
        {card.bench !== null ? <span>стоп: {card.bench.stopped}</span> : null}
        {verdict !== null ? (
          <span className={verdictTextTone(verdict.passed)}>вердикт: {verdict.passed ? 'passed' : verdict.action}</span>
        ) : null}
        <span className="ml-auto">{fmtUpdatedAt(card.updatedAt, nowMs)}</span>
      </div>

      <ArtifactChips stages={card.stages} titles={titles} compact />

      <CardActions card={card} className="flex gap-2" onOpenLive={onOpenLive} onOpenArchive={onOpenArchive} />
    </div>
  );
});
