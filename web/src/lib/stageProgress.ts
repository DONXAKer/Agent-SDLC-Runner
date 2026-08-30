import type { StageId } from '@sdlc-runner/shared';

/** Состояние этапа в индикаторе прогресса — то, что рисует кружок в StageRail. */
export type StageState = 'done' | 'running' | 'available' | 'blocked';

/** Ровно те поля `StageInfo`, по которым состояние выводимо, — тестам не нужен весь тип. */
export interface StageProgressInput {
  id: StageId;
  blockers: string[];
  /** Артефакты этапа существуют и заполнены — факт от сервера, см. `StageInfo.produced`. */
  produced: boolean;
  /** Этап законно пропускается сейчас — его артефакта не будет, см. `StageInfo.skipped`. */
  skipped: boolean;
}

/**
 * Состояние каждого этапа: `produced` с сервера + блокеры, без угадывания.
 *
 * Раньше «пройден» выводился эвристикой «самый дальний этап без блокеров — frontier,
 * всё до него done». Она врала на этапах с общими предусловиями: у ask и plan блокеры
 * пусты сразу после intent (им нужен только intent.md, не отчёт разведки) — и во время
 * работающей разведки ask красился пройденным, а plan — текущим. Теперь пройденность —
 * это факт «артефакты на диске», который сервер считает тем же чтением, что и блокеры.
 *
 * Доступных к запуску этапов может быть несколько одновременно — это правда конвейера,
 * а не дефект раскраски; какой из них «текущий», решает `suggestedStage`.
 */
export function computeStageStates(
  stages: readonly StageProgressInput[],
  runningStage: StageId | null,
): Partial<Record<StageId, StageState>> {
  const out: Partial<Record<StageId, StageState>> = {};
  for (const s of stages) {
    if (s.id === runningStage) out[s.id] = 'running';
    else if (s.produced) out[s.id] = 'done';
    else if (s.blockers.length === 0) out[s.id] = 'available';
    else out[s.id] = 'blocked';
  }
  return out;
}

/**
 * На какой этап вставать открытому витку — туда, где он реально находится, а не на `intent`.
 *
 * Идёт этап — на него. Красный вердикт — на chunk: методология возвращает виток именно
 * туда, а журнал прошлой попытки уже на диске, и по «первому без артефактов» интерфейс
 * предлагал бы верифицировать нечиненное. Иначе — первый доступный, чьи артефакты ещё не
 * готовы И который не пропускается методологией (условный `ask` без развилок артефакта
 * не произведёт никогда — виток парковался на нём навсегда). Все доступные уже
 * отработали — самый дальний из них: виток стоит у своего фронта.
 */
export function suggestedStage(
  runningStage: StageId | null,
  stages: readonly StageProgressInput[],
  verdictRed = false,
): StageId | null {
  if (runningStage !== null) return runningStage;
  if (verdictRed && stages.some((s) => s.id === 'chunk' && s.blockers.length === 0)) return 'chunk';
  const next = stages.find((s) => s.blockers.length === 0 && !s.produced && !s.skipped);
  if (next !== undefined) return next.id;
  const runnable = [...stages].reverse().find((s) => s.blockers.length === 0);
  return runnable?.id ?? null;
}
