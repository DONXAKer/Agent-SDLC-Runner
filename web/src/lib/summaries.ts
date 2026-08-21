import type { GateRunResult, GateStatus, PreparedPrompt } from '@sdlc-runner/shared';

import { fmtTokens } from './format.ts';
import { GATE_TONE } from './gateTone.ts';

/**
 * Строка-сводка промпта для свёрнутого вида.
 *
 * Токены — оценка по длине (~4 символа на токен), и подпись честно говорит «~»:
 * настоящего токенизатора на клиенте нет, а обещать точность, которой нет, нельзя.
 */
export function promptSummary(prompt: PreparedPrompt | null, edited: boolean): string {
  if (prompt === null) return 'промпт не собран';
  const approx = Math.round((prompt.system.length + prompt.user.length) / 4);
  return `собран · ~${fmtTokens(approx)} токенов${edited ? ' · изменён вручную' : ''}`;
}

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
