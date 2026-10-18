/**
 * Доска запусков: в каком столбце-этапе стоит карточка — там, где виток сейчас или застрял.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { DashboardStage, DashboardStageState, HistoryStatus, StageId } from '@sdlc-runner/shared';

import { BOARD_COLUMNS, boardPlace, groupBoard, miniCardPropsEqual, parseView } from '../src/lib/dashboardBoard.ts';
import type { BoardColumn } from '../src/lib/dashboardBoard.ts';

function card(states: Partial<Record<StageId, DashboardStageState>>, status: HistoryStatus = 'unfinished'): {
  stages: DashboardStage[];
  status: HistoryStatus;
} {
  return {
    status,
    stages: STAGE_ORDER.map((id) => ({ id, title: id, state: states[id] ?? 'notStarted', blamed: null, note: null, outputs: [] })),
  };
}

describe('boardPlace', () => {
  it('идущий этап — его столбец, даже если раньше был провал', () => {
    deepStrictEqual(boardPlace(card({ intent: 'done', explore: 'failed', plan: 'running' })), { column: 'plan', state: 'running' });
  });

  it('последний провал или блокировка — столбец застрявшего этапа', () => {
    deepStrictEqual(boardPlace(card({ intent: 'done', explore: 'done', plan: 'done', chunk: 'done', verify: 'failed' })), {
      column: 'verify',
      state: 'failed',
    });
    deepStrictEqual(boardPlace(card({ intent: 'done', chunk: 'blocked' })).column, 'chunk');
  });

  it('без провалов — первый не начатый после пройденных; пропуск считается закрытым', () => {
    deepStrictEqual(boardPlace(card({ intent: 'done', explore: 'done', ask: 'skipped' })), { column: 'plan', state: 'notStarted' });
    deepStrictEqual(boardPlace(card({})), { column: 'intent', state: 'notStarted' });
  });

  it('все этапы закрыты или виток передан — «Передан»', () => {
    const all = Object.fromEntries(STAGE_ORDER.map((s) => [s, 'done'])) as Record<StageId, DashboardStageState>;
    strictEqual(boardPlace(card(all)).column, 'done');
    strictEqual(boardPlace(card({ intent: 'done' }, 'done')).column, 'done');
  });

  it('группировка раскладывает по всем столбцам и сохраняет порядок', () => {
    const a = card({ intent: 'running' });
    const b = card({ intent: 'done', explore: 'failed' });
    const c = card({ intent: 'running' });
    const g = groupBoard([a, b, c]);
    deepStrictEqual(Object.keys(g), [...BOARD_COLUMNS]);
    deepStrictEqual(g.intent.map((x) => x.card), [a, c]);
    deepStrictEqual(g.explore.map((x) => x.card), [b]);
  });

  it('вид экрана из localStorage: по умолчанию доска', () => {
    strictEqual(parseView(null), 'board');
    strictEqual(parseView('grid'), 'grid');
    strictEqual(parseView('мусор'), 'board');
  });
});

// `place` — новый объект на каждую раскладку (`groupBoard` зовёт `boardPlace` заново для
// каждой карточки): голое сравнение по ссылке в `memo` бросало бы рендер мини-карточки на
// каждый опрос доски, даже когда карточка не изменилась (code-review-all, 2026-09-26).
describe('miniCardPropsEqual: сравнение place по значению, не по ссылке', () => {
  const onOpen = (): void => {};
  const sameCard = {};
  const props = (overrides: Partial<{ card: object; nowMs: number; place: { column: BoardColumn; state: DashboardStageState } }> = {}) => ({
    card: overrides.card ?? sameCard,
    nowMs: overrides.nowMs ?? 1,
    place: overrides.place ?? { column: 'intent' as BoardColumn, state: 'done' as DashboardStageState },
    onOpen,
  });

  it('новый объект place с теми же column/state — равны', () => {
    const a = props();
    const b = props({ place: { column: 'intent', state: 'done' } });
    strictEqual(a.place === b.place, false);
    strictEqual(miniCardPropsEqual(a, b), true);
  });

  it('разный column или state — не равны', () => {
    const a = props();
    strictEqual(miniCardPropsEqual(a, props({ place: { column: 'plan', state: 'done' } })), false);
    strictEqual(miniCardPropsEqual(a, props({ place: { column: 'intent', state: 'running' } })), false);
  });

  it('разный card (не переиспользован reuseCards) или nowMs — не равны', () => {
    const a = props();
    strictEqual(miniCardPropsEqual(a, props({ card: {} })), false);
    strictEqual(miniCardPropsEqual(a, props({ nowMs: 2 })), false);
  });
});
