/**
 * `max_tokens` по остатку окна контекста — общая формула для обоих исполнителей флоу
 * `loop`.
 *
 * `LoopExecutor` и `StepExecutor` расходятся в том, как узнают «сколько уже занято»:
 * первый — по `prompt_tokens` ПРЕДЫДУЩЕГО ответа сервера (растущая история циклом),
 * второй — прямой оценкой запроса, который сам же и собирает (каждый шаг плана —
 * независимый completion без общей истории). Дальше действует одна и та же формула и
 * один и тот же пол — раньше расчёт жил только внутри `LoopExecutor`, и `contextWindow`
 * на маршрутах `stepFill` (`config/models.json`) молча не давал никакой защиты: код,
 * исполняющий такой маршрут (`StepExecutor`), поле никогда не читал (найдено
 * code-review-all, 2026-09-11).
 */

/** Пол: почти заполненное окно не должно давать вырожденный «ответ из воздуха». */
export const MIN_MAX_TOKENS = 256;

/**
 * Байт на токен — та же грубая оценка, что у `mcp/select.ts` (`estimateTokens`): второй,
 * более точный токенайзер здесь не по адресу — оценка нужна для запаса, а не для точного
 * биллинга.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

export interface RemainingBudget {
  maxTokens: number;
  /**
   * Остаток ушёл ниже пола — окно genuinely почти или полностью занято. Отдельно от
   * `maxTokens`, чтобы вызывающий мог предупредить оператора: тихий пол выглядел бы как
   * рабочий расчёт, хотя это уже отказ признать, что защититься не вышло.
   */
  clamped: boolean;
}

/**
 * `contextWindow − usedTokens − marginTokens`, с полом `MIN_MAX_TOKENS`.
 *
 * Не гарантирует отсутствие переполнения — `usedTokens` сам может быть недооценён
 * (устаревшее измерение, грубая оценка по символам); гарантирует только то, что при
 * известных на этот момент числах используется вся посчитанная защита, а не только
 * жёсткая константа провайдера.
 */
export function maxTokensForRemaining(
  contextWindow: number,
  usedTokens: number,
  marginTokens: number,
): RemainingBudget {
  const remaining = contextWindow - usedTokens - marginTokens;
  return remaining < MIN_MAX_TOKENS
    ? { maxTokens: MIN_MAX_TOKENS, clamped: true }
    : { maxTokens: remaining, clamped: false };
}

/**
 * Запас под неучтённый прирост, кратный потолку одного результата/содержимого
 * (`maxResultBytes`), а не фиксированному числу токенов: до этой правки запас
 * (512 токенов) был на порядок меньше одного результата инструмента у потолка
 * `localMaxToolResultBytes` (12 000 байт ≈ 3000 токенов) — code-review-all, 2026-09-11.
 */
export function marginFor(maxResultBytes: number, resultsFactor: number): number {
  return Math.ceil(maxResultBytes / BYTES_PER_TOKEN_ESTIMATE) * resultsFactor;
}

/** Грубая оценка числа токенов в сообщениях чата — сумма длин `content` через `BYTES_PER_TOKEN_ESTIMATE`. */
export function estimateMessageTokens(messages: readonly { content: string }[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / BYTES_PER_TOKEN_ESTIMATE);
}
