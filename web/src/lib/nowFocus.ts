import type { StageId } from '@sdlc-runner/shared';

/**
 * Что на вкладке «Сейчас» главное в этот момент. Фокус — подсказка рендеру, а не
 * ограничение: блок в фокусе разворачивается, остальные сворачиваются в строки-сводки,
 * но оператор волен раскрыть любой вручную.
 */
export type NowFocus =
  | { kind: 'decisions'; count: number }
  | { kind: 'running'; stage: StageId }
  | { kind: 'verdict-red' }
  | { kind: 'prepare'; stage: StageId }
  | { kind: 'finished' };

/** Узкий вход вместо целого `RunDetail`: тестам не нужно строить весь ответ сервера. */
export interface NowFocusInput {
  /** Сколько карточек ждёт человека (вопросы + одобрения + приёмка записи). */
  queueCount: number;
  /** Этап, выполняющийся прямо сейчас, — `detail.stage`. */
  runningStage: StageId | null;
  /** Вердикт последней попытки есть и красный. */
  verdictRed: boolean;
  /** Самый дальний этап без блокеров — `suggestedStage(null, stages)`. */
  nextRunnable: StageId | null;
}

/**
 * Приоритет строго сверху вниз, и `decisions` — высший БЕЗУСЛОВНО: «молчание одобрением
 * не считается» держится на видимости карточек, и ни идущий этап, ни красный вердикт не
 * вправе задвинуть очередь решений. Дальше: идущий этап (живой прогресс), красный вердикт
 * (виток стоит и ждёт «попытка/chunk/обрыв»), подготовка следующего этапа. `finished` —
 * запускать нечего: либо handoff записан, либо все этапы заблокированы.
 */
export function computeNowFocus(input: NowFocusInput): NowFocus {
  if (input.queueCount > 0) return { kind: 'decisions', count: input.queueCount };
  if (input.runningStage !== null) return { kind: 'running', stage: input.runningStage };
  if (input.verdictRed) return { kind: 'verdict-red' };
  if (input.nextRunnable !== null) return { kind: 'prepare', stage: input.nextRunnable };
  return { kind: 'finished' };
}
