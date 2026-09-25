import { Fragment } from 'react';

import type { DashboardStage, StageId } from '@sdlc-runner/shared';

import { CIRCLE, STATE_LABEL, stageGlyph } from '../../lib/stageTone.ts';

/**
 * Семь этапов витка в строку — кружками той же палитры, что рельс страницы витка.
 * С `onSelect` кружки становятся кнопками выбора этапа (детальная карточка), без него —
 * только показ (сетка карточек).
 */
export function StageStrip({
  stages,
  selected,
  onSelect,
  withTitles = false,
}: {
  stages: readonly Pick<DashboardStage, 'id' | 'title' | 'state' | 'note'>[];
  selected?: StageId;
  onSelect?: (id: StageId) => void;
  /** Подписи под кружками — в деталях, где места хватает. */
  withTitles?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-y-1">
      {stages.map((s, idx) => {
        const hint = `${s.title} — ${STATE_LABEL[s.state].text}${s.note === null ? '' : `: ${s.note}`}`;
        const circle = (
          <span
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${CIRCLE[s.state]} ${
              selected === s.id ? 'ring-2 ring-neutral-300' : ''
            }`}
          >
            {stageGlyph(s.state, idx)}
          </span>
        );
        const body = withTitles ? (
          <span className="flex flex-col items-center gap-0.5">
            {circle}
            <span className={`text-[10px] ${selected === s.id ? 'text-neutral-200' : STATE_LABEL[s.state].cls}`}>{s.title}</span>
          </span>
        ) : (
          circle
        );
        return (
          <Fragment key={s.id}>
            {idx > 0 ? <span className={`mt-2.5 h-px ${withTitles ? 'w-4' : 'w-2.5'} shrink-0 bg-neutral-800`} /> : null}
            {onSelect === undefined ? (
              <span title={hint}>{body}</span>
            ) : (
              <button
                type="button"
                title={hint}
                onClick={() => onSelect(s.id)}
                className="rounded px-0.5 hover:bg-neutral-800/60"
              >
                {body}
              </button>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
