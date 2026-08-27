import type { StageId } from '@sdlc-runner/shared';

/** Состояние этапа в индикаторе прогресса — то, что рисует кружок в StageRail. */
export type StageState = 'done' | 'running' | 'available' | 'blocked';

/** Ровно те поля `StageInfo`, по которым состояние выводимо, — тестам не нужен весь тип. */
export interface StageProgressInput {
  id: StageId;
  blockers: string[];
}

/**
 * Вывести состояние каждого этапа из блокеров.
 *
 * «Пройден» сервер не отдаёт, но он выводим: блокеры считаются чтением артефактов с
 * диска, и если этап k разблокирован — артефакты всех предыдущих на месте. Берётся
 * САМЫЙ ДАЛЬНИЙ разблокированный (frontier): всё до него — `done`, он сам — `available`,
 * дальше — `blocked`. Выводить пройденность из ленты событий нельзя: буфер шины
 * ограничен и вытесняет с начала, а при реконнекте лента сбрасывается — тот же урок,
 * что у `mergePending`.
 *
 * Оговорка: условный этап (`ask` — «нет развилок, нет шага») перед frontier'ом тоже
 * помечается `done`, хотя мог не запускаться, — по файлам «выполнен» и «не понадобился»
 * неразличимы, и различать их здесь значило бы угадывать.
 */
export function computeStageStates(
  stages: readonly StageProgressInput[],
  runningStage: StageId | null,
): Partial<Record<StageId, StageState>> {
  let frontier = -1;
  stages.forEach((s, i) => {
    if (s.blockers.length === 0) frontier = i;
  });

  const out: Partial<Record<StageId, StageState>> = {};
  stages.forEach((s, i) => {
    if (s.id === runningStage) out[s.id] = 'running';
    else if (i < frontier) out[s.id] = 'done';
    else if (i === frontier) out[s.id] = 'available';
    else out[s.id] = 'blocked';
  });
  return out;
}

/**
 * На какой этап вставать открытому витку — туда, где он реально находится, а не на `intent`.
 *
 * `runningStage` не пуст ровно тогда, когда этап крутится прямо сейчас, — а виток чаще
 * всего открывают, когда он СТОИТ между этапами, и сид по одному этому полю не срабатывал
 * именно в самом частом случае. Запасной признак — самый дальний этап без блокеров: до
 * него виток уже дошёл.
 */
export function suggestedStage(
  runningStage: StageId | null,
  stages: readonly StageProgressInput[],
): StageId | null {
  if (runningStage !== null) return runningStage;
  const runnable = [...stages].reverse().find((s) => s.blockers.length === 0);
  return runnable?.id ?? null;
}
