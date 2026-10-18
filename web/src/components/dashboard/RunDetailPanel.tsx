import { useState } from 'react';

import type { DashboardDetail, StageId } from '@sdlc-runner/shared';

import { defaultDetailStage } from '../../lib/dashboardStages.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost, fmtTokens } from '../../lib/format.ts';
import { historyStatusLabel, historyStatusTone } from '../../lib/historyStatus.ts';
import { verdictTextTone } from '../../lib/tones.ts';
import { CollapsibleSection } from '../run/CollapsibleSection.tsx';
import { ArtifactChips } from './ArtifactChips.tsx';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { CardActions } from './CardActions.tsx';
import { SourceBadge } from './SourceBadge.tsx';
import { StageDetail } from './StageDetail.tsx';
import { StageStrip } from './StageStrip.tsx';

/**
 * Детальная карточка запуска — полноэкранно, как архивная лента: промпты и файлы в
 * десятки килобайт в боковой панели не читаются. Только чтение: действия над живым витком
 * — на его странице (кнопка «открыть живой виток»).
 */
export function RunDetailPanel({
  detail,
  titles,
  nowMs,
  gone,
  onBack,
  onOpenLive,
  onOpenArchive,
}: {
  detail: DashboardDetail;
  titles: Partial<Record<StageId, string>>;
  nowMs: number;
  /** Карточки больше нет в списке (каталог удалён, прогон убран) — показываем последнее известное. */
  gone: boolean;
  onBack: () => void;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
}): JSX.Element {
  const { card } = detail;
  // Выбранный этап — не в адресе: ссылку дают на карточку, а этап открывается разумный.
  const [selected, setSelected] = useState<StageId>(() => defaultDetailStage(detail.stages));
  const stage = detail.stages.find((s) => s.id === selected) ?? detail.stages[0];
  const verdict = card.bench?.finalVerdict ?? detail.stages.find((s) => s.id === 'verify')?.lastRun?.verdict ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2.5">
        <button type="button" onClick={onBack} className="text-sm text-neutral-400 hover:text-neutral-200">
          ← к карточкам
        </button>
        <SourceBadge source={card.ref.source} />
        <span className="min-w-0 truncate font-mono text-sm">
          <span className="text-neutral-500">{card.ref.project} · </span>
          {card.ref.slug}
        </span>
        <span className={`rounded border px-1.5 py-px text-[10px] ${historyStatusTone(card.status)}`}>{historyStatusLabel(card.status)}</span>
        <a href={`/api/dashboard/${encodeURIComponent(card.ref.source)}/${encodeURIComponent(card.ref.project)}/${encodeURIComponent(card.ref.slug)}/flow.html`}
          target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300">Схема прогона</a>
        <CardActions card={card} className="ml-auto flex gap-2" onOpenLive={onOpenLive} onOpenArchive={onOpenArchive} />
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4">
        {gone ? (
          <div className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            Карточки больше нет в списке — показано последнее известное состояние.
          </div>
        ) : null}

        <div className="space-y-1 text-xs text-neutral-400">
          {card.requirement !== undefined ? <div className="text-sm text-neutral-200">{card.requirement}</div> : null}
          {card.bench !== null ? (
            <div>
              задача <span className="font-mono text-neutral-300">{card.bench.task}</span> · модель{' '}
              <span className="font-mono text-neutral-300">{card.bench.model}</span> · режим{' '}
              {card.bench.mode.kind === 'all' ? 'весь виток' : `этап ${titles[card.bench.mode.stage] ?? card.bench.mode.stage}`} · стоп:{' '}
              {card.bench.stopped}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span>
              chunk {card.chunk} · попытка {card.attempt}
            </span>
            {card.usage !== null ? (
              <span>
                {fmtTokens(card.usage.inputTokens)} ↑ {fmtTokens(card.usage.outputTokens)} ↓ · {fmtCost(card.usage, card.currency)}
              </span>
            ) : (
              <span>чисел раннера нет</span>
            )}
            {card.runCount > 0 ? <span>запусков раннера: {card.runCount}</span> : null}
            {verdict !== null ? (
              <span className={verdictTextTone(verdict.passed)}>вердикт: {verdict.passed ? 'passed' : `не пройден · ${verdict.action}`}</span>
            ) : null}
            <span>изменён {fmtUpdatedAt(card.updatedAt, nowMs)}</span>
          </div>
        </div>

        <div className="rounded border border-neutral-800 p-3">
          <StageStrip stages={detail.stages} selected={selected} onSelect={setSelected} withTitles />
          <div className="mt-3">
            <ArtifactChips stages={detail.stages} titles={titles} />
          </div>
        </div>

        {stage !== undefined ? <StageDetail card={card} stage={stage} titles={titles} /> : null}

        {detail.iterations.length > 0 ? (
          <CollapsibleSection title="Попытки" summary={`${detail.iterations.length}`} compact defaultOpen={false}>
            <table className="w-full text-xs">
              <tbody>
                {/* Ключ — позиция: повторный verify той же попытки дописывает вторую строку с
                    теми же chunk/попыткой, и ключ по ним был бы не уникален. */}
                {detail.iterations.map((it, i) => (
                  <tr key={i} className="border-t border-neutral-900 align-top">
                    <td className="px-3 py-1 font-mono text-neutral-500">
                      {it.chunk}/{it.attempt}
                    </td>
                    <td className={`px-3 py-1 ${verdictTextTone(it.passed)}`}>{it.passed ? 'passed' : it.action}</td>
                    <td className="px-3 py-1 text-neutral-400">{it.reasons.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection title="Все файлы" summary={`${detail.artifacts.length}`} compact defaultOpen={false}>
          <div className="px-3 pb-3">
            {detail.artifacts.length === 0 ? (
              <div className="pt-2 text-xs text-neutral-500">файлов нет</div>
            ) : (
              detail.artifacts.map((a) => <ArtifactViewer key={a.name} cardRef={card.ref} artifact={a} />)
            )}
          </div>
        </CollapsibleSection>
      </main>
    </div>
  );
}
