import type { DashboardStageDetail, StageId } from '@sdlc-runner/shared';

import { CIRCLE, STATE_LABEL, stageGlyph } from '../../lib/stageTone.ts';

export function StageTimeline({
  stages,
  selected,
  titles,
  onSelect,
}: {
  stages: readonly DashboardStageDetail[];
  selected: StageId;
  titles: Partial<Record<StageId, string>>;
  onSelect: (stage: StageId) => void;
}): JSX.Element {
  return (
    <ol className="ml-2 space-y-1 border-l border-neutral-800 pl-4">
      {stages.map((stage, index) => {
        const active = stage.id === selected;
        return (
          <li key={stage.id} className="relative">
            <span className={`absolute -left-[25px] top-3 inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${CIRCLE[stage.state]}`}>
              {stageGlyph(stage.state, index)}
            </span>
            <button
              type="button"
              onClick={() => onSelect(stage.id)}
              className={`w-full rounded border px-2.5 py-2 text-left ${active ? 'border-neutral-600 bg-neutral-800/70' : stage.state === 'failed' ? 'border-red-900 bg-red-950/20 hover:border-red-700' : 'border-transparent hover:bg-neutral-900'}`}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-neutral-200">{stage.title}</span>
                <span className={`ml-auto text-[10px] ${STATE_LABEL[stage.state].cls}`}>{STATE_LABEL[stage.state].text}</span>
              </span>
              {stage.note !== null ? <span className={`mt-1 block whitespace-pre-wrap break-words text-[11px] leading-4 ${stage.state === 'failed' ? 'text-red-300' : 'text-neutral-500'}`}>{stage.note}</span> : null}
              {stage.blamed !== null ? <span className="mt-1 block text-[11px] text-amber-300">виновник: {titles[stage.blamed] ?? stage.blamed}</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
