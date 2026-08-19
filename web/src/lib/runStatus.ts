import type { RunStatus, StageId } from '@sdlc-runner/shared';

/**
 * Подпись и цвет статуса — один на все поверхности.
 *
 * `RunStatus` относится к ПОСЛЕДНЕМУ ЭТАПУ, а не к витку, поэтому все подписи говорят про
 * этап. Слово «завершён» здесь недопустимо: виток из семи этапов после первого же
 * успешного выглядел бы законченным.
 */

const LABEL: Record<RunStatus, string> = {
  idle: 'не запускался',
  running: 'этап идёт',
  awaiting: 'ждёт человека',
  done: 'этап пройден',
  failed: 'этап провален',
  cancelled: 'этап отменён',
};

const TONE: Record<RunStatus, string> = {
  idle: 'border-neutral-700 text-neutral-400',
  running: 'border-emerald-700 text-emerald-300',
  // Ждёт человека — единственный статус, который требует действия прямо сейчас.
  awaiting: 'border-amber-700 text-amber-300',
  done: 'border-neutral-700 text-neutral-300',
  failed: 'border-red-800 text-red-300',
  cancelled: 'border-neutral-700 text-neutral-500',
};

/**
 * Статус выставляет `Run`, а `stage` (выполняющийся сейчас этап) — HTTP-слой, и снимается
 * он позже: отмена ставит `cancelled` сразу, а исполнитель ещё доматывает вызов. Пока эти
 * два факта рендерились независимо, строка читалась как «выполняется chunk · этап отменён».
 */
export function statusLabel(status: RunStatus, stage: StageId | null): string {
  if (stage !== null && status === 'cancelled') return 'останавливается…';
  return LABEL[status];
}

export function statusTone(status: RunStatus, stage: StageId | null): string {
  if (stage !== null && status === 'cancelled') return 'border-amber-700 text-amber-300';
  return TONE[status];
}
