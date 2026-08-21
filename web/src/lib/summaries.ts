import type { GateRunResult, GateStatus, PreparedPrompt } from '@sdlc-runner/shared';

import { GATE_TONE } from './gateTone.ts';

/**
 * Строка-сводка промпта для свёрнутого вида.
 *
 * Счёт в символах, тем же форматом, что и строка ленты («N + M симв.» у `prompt_prepared`
 * в EventStream) — раньше здесь была оценка в токенах по длине (~4 символа/токен), и один
 * и тот же промпт показывал два разных числа на двух поверхностях. Настоящих токенов до
 * вызова не существует (это не оценка, а измерение постфактум) — то, что показывает
 * `usage` после прогона, законно другое число, а не третий формат того же самого.
 *
 * Вызывающая сторона отвечает за случай `prompt === null` сама (см. `PromptPane`, где
 * несобранный промпт — отдельный ранний return, а не состояние свёрнутой сводки).
 */
export function promptSummary(prompt: PreparedPrompt, edited: boolean): string {
  return `собран · ${prompt.system.length} + ${prompt.user.length} симв.${
    edited ? ' · изменён вручную' : ''
  }`;
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
