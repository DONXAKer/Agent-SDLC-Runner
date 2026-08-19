import type { GateStatus } from '@sdlc-runner/shared';

/**
 * Цвет статуса гейта — один на все поверхности.
 *
 * `Record` по `GateStatus`, а не тернарник: у развилки «зелёный / красный / всё остальное»
 * новый статус молча получал бы жёлтый, тогда как здесь его отсутствие ловит сборка.
 */
export const GATE_TONE: Record<GateStatus, string> = {
  '✅': 'text-emerald-400',
  '❌': 'text-red-400',
  '⏭': 'text-amber-400',
};
