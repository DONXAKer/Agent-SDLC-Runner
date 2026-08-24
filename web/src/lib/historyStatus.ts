import type { HistoryStatus } from '@sdlc-runner/shared';

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
  done: 'border-neutral-700 text-neutral-300',
  aborted: 'border-red-800 text-red-300',
  open: 'border-emerald-700 text-emerald-300',
  unfinished: 'border-amber-700 text-amber-300',
};

export function historyStatusLabel(status: HistoryStatus): string {
  return LABEL[status];
}

export function historyStatusTone(status: HistoryStatus): string {
  return TONE[status];
}
