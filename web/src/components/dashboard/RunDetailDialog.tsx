import { useState } from 'react';

import type { DashboardDetail, StageId } from '@sdlc-runner/shared';

import { defaultDetailStage, focusStage } from '../../lib/dashboardStages.ts';
import { fmtUpdatedAt } from '../../lib/dashboardTime.ts';
import { fmtCost, fmtTokens } from '../../lib/format.ts';
import { stageProblems } from '../../lib/flowTimeline.ts';
import { historyStatusLabel, historyStatusTone } from '../../lib/historyStatus.ts';
import { verdictTextTone } from '../../lib/tones.ts';
import { Modal } from '../Modal.tsx';
import { CollapsibleSection } from '../run/CollapsibleSection.tsx';
import { ArtifactChips } from './ArtifactChips.tsx';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { CardActions } from './CardActions.tsx';
import { SourceBadge } from './SourceBadge.tsx';
import { StageDetail } from './StageDetail.tsx';
import { StageTimeline } from './StageTimeline.tsx';

export function RunDetailDialog({
  detail,
  titles,
  nowMs,
  gone,
  onClose,
  onOpenLive,
  onOpenArchive,
}: {
  detail: DashboardDetail;
  titles: Partial<Record<StageId, string>>;
  nowMs: number;
  gone: boolean;
  onClose: () => void;
  onOpenLive: (runId: string) => void;
  onOpenArchive: (project: string, slug: string) => void;
}): JSX.Element {
  const { card } = detail;
  const [selected, setSelected] = useState<StageId>(() => defaultDetailStage(detail.stages));
  const stage = detail.stages.find((item) => item.id === selected) ?? detail.stages[0];
  const focus = focusStage(detail.stages);
  const problemStage = focus === null ? undefined : detail.stages.find((item) => item.id === focus.id);
  const problems = problemStage === undefined ? null : stageProblems(problemStage);
  const verdict = card.bench?.finalVerdict ?? detail.stages.find((item) => item.id === 'verify')?.lastRun?.verdict ?? null;

  return (
    <Modal title={`${card.ref.project} · ${card.ref.slug}`} onClose={onClose} className="max-w-[96rem]">
      <div className="space-y-4 p-4">
        <header className="flex flex-wrap items-center gap-2">
          <SourceBadge source={card.ref.source} />
          <span className={`rounded border px-1.5 py-px text-[10px] ${historyStatusTone(card.status)}`}>{historyStatusLabel(card.status)}</span>
          <a href={`/api/dashboard/${encodeURIComponent(card.ref.source)}/${encodeURIComponent(card.ref.project)}/${encodeURIComponent(card.ref.slug)}/flow.html`} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300">Полная трасса</a>
          <CardActions card={card} className="ml-auto flex gap-2" onOpenLive={onOpenLive} onOpenArchive={onOpenArchive} />
        </header>

        {gone ? <div className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">Карточки больше нет в списке — показано последнее известное состояние.</div> : null}

        <section className="space-y-2 text-xs text-neutral-400">
          {card.requirement !== undefined ? <div className="text-sm text-neutral-200">{card.requirement}</div> : null}
          {card.bench !== null ? <div>задача <span className="font-mono text-neutral-300">{card.bench.task}</span> · модель <span className="font-mono text-neutral-300">{card.bench.model}</span> · режим {card.bench.mode.kind === 'all' ? 'весь виток' : `этап ${titles[card.bench.mode.stage] ?? card.bench.mode.stage}`} · стоп: {card.bench.stopped}</div> : null}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>chunk {card.chunk} · попытка {card.attempt}</span>
            {card.usage !== null ? <span>{fmtTokens(card.usage.inputTokens)} ↑ {fmtTokens(card.usage.outputTokens)} ↓ · {fmtCost(card.usage, card.currency)}</span> : <span>чисел раннера нет</span>}
            {card.runCount > 0 ? <span>запусков раннера: {card.runCount}</span> : null}
            {verdict !== null ? <span className={verdictTextTone(verdict.passed)}>вердикт: {verdict.passed ? 'passed' : `не пройден · ${verdict.action}`}</span> : null}
            <span>изменён {fmtUpdatedAt(card.updatedAt, nowMs)}</span>
          </div>
          <ArtifactChips stages={detail.stages} titles={titles} />
        </section>

        <div className="grid gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
          <aside className="rounded border border-neutral-800 p-3 lg:sticky lg:top-0 lg:self-start">
            <div className="mb-3 px-1 text-xs uppercase tracking-wide text-neutral-500">Флоу запуска</div>
            <StageTimeline stages={detail.stages} selected={selected} titles={titles} onSelect={setSelected} />
          </aside>

          <main className="min-w-0 space-y-4">
            {problemStage !== undefined && problems !== null ? (
              <section className={`rounded border p-3 ${problems.errors.length > 0 ? 'border-red-900 bg-red-950/20' : 'border-neutral-800'}`}>
                <h3 className={`text-sm font-medium ${problems.errors.length > 0 ? 'text-red-300' : 'text-neutral-200'}`}>
                  {problemStage.state === 'running' ? 'Сейчас выполняется' : problemStage.state === 'blocked' ? 'Где остановлено' : 'Где упало'}: {problemStage.title}
                </h3>
                {problems.errors.length > 0 ? <ul className="mt-2 space-y-1 text-xs text-red-200">{problems.errors.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">— {line}</li>)}</ul> : <p className="mt-2 text-xs text-neutral-400">{problemStage.note ?? 'Ошибок в последнем запуске этапа не записано.'}</p>}
                {problems.warnings.length > 0 ? <ul className="mt-2 space-y-1 text-xs text-amber-300">{problems.warnings.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words">предупреждение: {line}</li>)}</ul> : null}
              </section>
            ) : null}
            {stage !== undefined ? <StageDetail card={card} stage={stage} titles={titles} /> : null}
          </main>
        </div>

        {detail.iterations.length > 0 ? (
          <CollapsibleSection title="Попытки" summary={`${detail.iterations.length}`} compact defaultOpen={false}>
            <table className="w-full text-xs"><tbody>{detail.iterations.map((iteration, index) => <tr key={index} className="border-t border-neutral-900 align-top"><td className="px-3 py-1 font-mono text-neutral-500">{iteration.chunk}/{iteration.attempt}</td><td className={`px-3 py-1 ${verdictTextTone(iteration.passed)}`}>{iteration.passed ? 'passed' : iteration.action}</td><td className="px-3 py-1 text-neutral-400">{iteration.reasons.join('; ')}</td></tr>)}</tbody></table>
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection title="Все файлы" summary={`${detail.artifacts.length}`} compact defaultOpen={false}>
          <div className="px-3 pb-3">{detail.artifacts.length === 0 ? <div className="pt-2 text-xs text-neutral-500">файлов нет</div> : detail.artifacts.map((artifact) => <ArtifactViewer key={artifact.name} cardRef={card.ref} artifact={artifact} />)}</div>
        </CollapsibleSection>
      </div>
    </Modal>
  );
}
