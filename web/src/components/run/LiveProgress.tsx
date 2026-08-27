import { useMemo } from 'react';

import type { RunEvent } from '@sdlc-runner/shared';

import { tailGroupedEvents } from '../../lib/eventGroups.ts';
import { EventStream } from '../EventStream.tsx';

/** Сколько сгруппированных строк ленты видно в живом прогрессе на «Сейчас». */
const TAIL_GROUPS = 8;

/**
 * Живой прогресс идущего этапа на вкладке «Сейчас» — хвост ленты, а не вся она.
 *
 * Пока этап выполнялся, «Сейчас» не показывала ничего живого: прогресс жил на соседней
 * вкладке «Ход», и оператор смотрел на мёртвые textarea уже отправленного промпта.
 * Полная лента остаётся на «Ходе»; токены и стоимость не дублируются — они всегда видны
 * в шапке (`CostBar`).
 */
export function LiveProgress({
  events,
  onOpenFull,
}: {
  /** События ИДУЩЕГО этапа — не выбранного в рельсе: живой прогресс про то, что крутится. */
  events: RunEvent[];
  /** Переход на вкладку «Ход» за полной лентой. */
  onOpenFull: () => void;
}): JSX.Element {
  const tail = useMemo(() => tailGroupedEvents(events, TAIL_GROUPS), [events]);

  return (
    <div>
      {tail.length === 0 ? (
        <div className="text-xs text-neutral-500">Этап запущен, событий пока нет…</div>
      ) : (
        <div className="max-h-80 overflow-auto rounded bg-neutral-950 p-3">
          <EventStream events={tail} />
        </div>
      )}
      <button
        type="button"
        onClick={onOpenFull}
        className="mt-2 text-xs text-neutral-400 hover:text-neutral-200"
      >
        полная лента → вкладка «Ход»
      </button>
    </div>
  );
}
