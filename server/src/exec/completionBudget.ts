/**
 * Одна лестница бюджета ответа (`max_tokens`) на все JSON-решения guided-рантайма.
 *
 * До этого модуля лимит поднимали независимо пять мест — `DecisionEngine`, независимое
 * ревью плана (`run/preparationReview.ts`), `GuidedExecutor`/`GuidedPlanExecutor`
 * (`tokenCap`), `GuidedAskExecutor` — каждое своей константой и своим числом подъёмов.
 * Серия r6 (2026-10-27) показала общий для них класс отказа: рассуждающая модель (gpt-oss,
 * granite) тратит весь лимит на поле `reasoning`, `content` остаётся пустым, и каждое
 * место тратило по два-три запроса (минуты стенных часов) на лестницу 4096 → 8192 →
 * 16384, прежде чем получить ответ. Профиль рассуждения модели известен ДО запроса
 * (`ModelDef.reasoning`), и стартовать с потолка — решение одного места, а не пяти.
 *
 * Чистая функция: ни I/O, ни знания о модели кроме профиля. Имён моделей здесь нет —
 * профиль задаёт оператор в `config/models.json` (или паспорт преполёта).
 */

import { MIN_MAX_TOKENS } from './contextBudget.ts';

/**
 * Профиль рассуждения записи модели:
 *  - `none`  — рассуждения в ответе нет (или оно выключено параметром); обрыв означает
 *    длинный контент, один подъём — предел разумного;
 *  - `light` — умолчание: рассуждение возможно, короткое; две ступени как прежде;
 *  - `heavy` — рассуждение занимает тысячи токенов; стартуем сразу с потолка, лестницы нет.
 */
export type ReasoningProfile = 'none' | 'light' | 'heavy';

/** Умолчание стартового лимита — прежняя константа всех пяти мест. */
export const DEFAULT_COMPLETION_TOKENS = 4096;
/** Потолок completion по умолчанию — прежний `tokenCap`/`completionCeiling`. */
export const COMPLETION_CEILING = 16_384;
/** Запас окна под обёртку чат-шаблона — прежняя константа `- 1024` исполнителей. */
export const COMPLETION_RESERVE = 1024;

export interface CompletionLadderInput {
  contextWindow: number;
  promptTokens: number;
  reasoning?: ReasoningProfile | undefined;
  /** Явный `max_tokens` оператора — стартовая ступень (прежняя семантика `DecisionEngine`). */
  requested?: number | undefined;
  /** Верхняя планка (`maxTokensLimit`); не задана — `COMPLETION_CEILING`. */
  ceiling?: number | undefined;
  /** Запас окна; не задан — `COMPLETION_RESERVE`. */
  reserve?: number | undefined;
}

export interface CompletionLadder {
  /** Первая ступень. */
  start: number;
  /** Выше не поднимается ни одна ступень: остаток окна и явная планка. */
  ceiling: number;
  /** Сколько подъёмов допускает профиль. */
  maxRaises: number;
  /** Следующая ступень после `current` с учётом уже сделанных подъёмов; `null` — поднимать некуда. */
  next(current: number, raises: number): number | null;
}

const RAISES: Record<ReasoningProfile, number> = { none: 1, light: 2, heavy: 0 };

export function completionLadder(input: CompletionLadderInput): CompletionLadder {
  const profile: ReasoningProfile = input.reasoning ?? 'light';
  const reserve = input.reserve ?? COMPLETION_RESERVE;
  const available = Math.max(MIN_MAX_TOKENS, input.contextWindow - input.promptTokens - reserve);
  // Пол действует на остаток окна; явная планка вызывающего — закон и ниже пола.
  const ceiling = Math.min(input.ceiling ?? COMPLETION_CEILING, available);
  const base = Math.min(input.requested ?? DEFAULT_COMPLETION_TOKENS, ceiling);
  const maxRaises = RAISES[profile];
  const start = profile === 'heavy' ? ceiling : base;
  return {
    start, ceiling, maxRaises,
    next(current, raises) {
      if (raises >= maxRaises || current >= ceiling) return null;
      // Та же ступень, что была у всех пяти мест: удвоение, но не ниже 8192.
      const raised = Math.min(ceiling, Math.max(current * 2, 8192));
      return raised > current ? raised : null;
    },
  };
}

/**
 * Доля рассуждения в ответе по `Usage` — признак того, что обрыв/пустой `content` вызван
 * рассуждением, а не длинным ответом. `null` — сервер рассуждение не отдал.
 */
export function reasoningShare(usage: { outputTokens: number; reasoningTokens?: number | undefined }): number | null {
  if (usage.reasoningTokens === undefined || usage.outputTokens <= 0) return null;
  return Math.min(1, usage.reasoningTokens / usage.outputTokens);
}
