import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { DashboardCard, DashboardStageState, StageId } from '@sdlc-runner/shared';

import { focusStage } from './dashboardStages.ts';

/**
 * Доска запусков: столбец на этап витка плюс «Передан». Карточка стоит в столбце этапа,
 * на котором виток сейчас — идёт, упал, стоит или дальше не двинулся, — чтобы одним
 * взглядом было видно, где что зависло, и у идущих, и у давно брошенных.
 */
export type BoardColumn = StageId | 'done';

export const BOARD_COLUMNS: readonly BoardColumn[] = [...STAGE_ORDER, 'done'];

/** Где карточка на доске и в каком состоянии её этап. */
export interface BoardPlace {
  column: BoardColumn;
  /** Состояние этапа столбца; у «Передан» — `done`. */
  state: DashboardStageState;
}

const CLOSED: ReadonlySet<DashboardStageState> = new Set(['done', 'skipped']);

/**
 * Порядок выбора: идущий этап → последний проваленный или заблокированный → первый не
 * начатый после последнего пройденного → «Передан». Виток, переданный человеком (статус
 * `done`), — всегда «Передан»: этапы после приёмки уже не про него.
 */
export function boardPlace(card: Pick<DashboardCard, 'stages' | 'status'>): BoardPlace {
  const stages = card.stages;
  // То же правило «где виток», что у подписи карточки и деталей (`focusStage`).
  const focus = focusStage(stages);
  if (focus !== null && focus.state === 'running') return { column: focus.id, state: 'running' };
  if (card.status === 'done') return { column: 'done', state: 'done' };
  if (focus !== null) return { column: focus.id, state: focus.state };
  let lastClosed = -1;
  stages.forEach((s, i) => {
    if (CLOSED.has(s.state)) lastClosed = i;
  });
  const next = stages.find((s, i) => i > lastClosed && !CLOSED.has(s.state));
  if (next !== undefined) return { column: next.id, state: next.state };
  return { column: 'done', state: 'done' };
}

/** Карточки по столбцам; порядок внутри столбца — порядок входа. */
export function groupBoard<T extends Pick<DashboardCard, 'stages' | 'status'>>(
  cards: readonly T[],
): Record<BoardColumn, { card: T; place: BoardPlace }[]> {
  const out = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, []])) as unknown as Record<
    BoardColumn,
    { card: T; place: BoardPlace }[]
  >;
  for (const card of cards) {
    const place = boardPlace(card);
    out[place.column].push({ card, place });
  }
  return out;
}

/**
 * `place` — новый объект на каждую раскладку доски (`groupBoard` зовёт `boardPlace(card)`
 * заново для каждой карточки, а массив карточек — новый на каждый опрос, даже когда сами
 * карточки переиспользованы `reuseCards`), поэтому сравнение мини-карточки в `memo` по
 * ссылке не бросало бы рендер ни разу: `place` отличается всегда, даже когда `column`/
 * `state` те же. Сравниваются `place.column`/`place.state` по значению — тогда неизменная
 * карточка не перерисовывается.
 */
export function miniCardPropsEqual<T extends { card: unknown; place: BoardPlace; nowMs: number; onOpen: unknown }>(a: T, b: T): boolean {
  return a.card === b.card && a.nowMs === b.nowMs && a.onOpen === b.onOpen && a.place.column === b.place.column && a.place.state === b.place.state;
}

/** Вид экрана запусков — помнится между заходами. */
export type DashboardView = 'grid' | 'board';

export function parseView(raw: string | null): DashboardView {
  return raw === 'grid' ? 'grid' : 'board';
}
