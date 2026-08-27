import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import { GATE_TONE } from './gateTone.ts';

/**
 * Счётчики гейтов по статусам.
 *
 * Строятся по ключам общей карты, а не тремя `filter` по литералам: иначе новый статус
 * не попал бы ни в один счётчик, и сумма молча разошлась бы с «всего».
 */
export function gateSummary(results: GateRunResult[]): { status: GateStatus; n: number }[] {
  return (Object.keys(GATE_TONE) as GateStatus[]).map((status) => ({
    status,
    n: results.filter((r) => r.status === status).length,
  }));
}
