import type { HistoryStatus } from '@sdlc-runner/shared';

import { BADGE_TONE } from './tones.ts';

/**
 * Подпись и цвет статуса витка ЦЕЛИКОМ — не путать с `runStatus.ts` (статус последнего
 * этапа живого прогона). Источник здесь — файлы на диске, см. `server/src/history.ts`.
 */

const LABEL: Record<HistoryStatus, string> = {
  done: 'передан',
  aborted: 'оборван',
  open: 'в работе',
  unfinished: 'без записи о передаче',
};

const TONE: Record<HistoryStatus, string> = {
  done: BADGE_TONE.neutral,
  aborted: BADGE_TONE.red,
  open: BADGE_TONE.emerald,
  unfinished: BADGE_TONE.amber,
};

export function historyStatusLabel(status: HistoryStatus): string {
  return LABEL[status];
}

export function historyStatusTone(status: HistoryStatus): string {
  return TONE[status];
}
