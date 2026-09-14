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

import { applyParams } from '../provider/ChatProvider.ts';

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

/**
 * Запас на неточность самой оценки — для запросов БЕЗ инструментов (полевые запросы
 * `FormFillExecutor`), где между оценкой и отправкой ничего не прирастает.
 *
 * Не кратен `maxResultBytes`: результатов инструментов в таком запросе нет по построению, а
 * запас в целый результат (~3000 токенов у `localMaxToolResultBytes`) на окне 16K съедал
 * пятую часть окна и сажал `max_tokens` на пол — ответ поля обрезался. Сама оценка по байтам
 * ЗАВЫШАЕТ (~18% по `prompt_tokens` relog серии v5), поэтому поправка вверх ей не нужна;
 * запас покрывает то, чего в `content` нет вовсе, — обёртку чат-шаблона (маркеры ролей,
 * BOS, приглашение к генерации): десятки токенов на сообщение, а сообщений у полевого
 * запроса два. Равен `MIN_MAX_TOKENS`, чтобы порядок величины был один на весь расчёт.
 */
export const ESTIMATE_MARGIN_TOKENS = MIN_MAX_TOKENS;

export interface BudgetParamsInput {
  /** `ModelDef.contextWindow`; не задано — расчёта нет, `params` уходят как есть. */
  contextWindow: number | undefined;
  /** `ModelDef.params`: явный `max_tokens` оператора перекрывает вычисленный. */
  params: Record<string, unknown> | null | undefined;
  /** Занято окна — измерение сервера либо оценка запроса. */
  promptTokens: number;
  marginTokens: number;
  /**
   * Остаток ушёл ниже пола. Текст предупреждения у каждого исполнителя свой («полевым
   * запросом», «вопросом разведки», «из истории»), поэтому колбэк, а не строка здесь.
   */
  onClamped: (maxTokens: number) => void;
}

/**
 * `params` запроса с `max_tokens` по остатку окна — общая обвязка четырёх исполнителей флоу
 * `loop`. До выноса она жила копией в каждом, и правка одной копии (порядок `applyParams`,
 * предупреждение о поле) не доезжала до остальных.
 *
 * `applyParams` после вычисленного значения — тем же порядком, что у провайдера: оператор,
 * назвавший число явно, знает больше рантайма.
 */
export function budgetParams(o: BudgetParamsInput): Record<string, unknown> | null {
  if (o.contextWindow === undefined) return o.params ?? null;
  const budget = maxTokensForRemaining(o.contextWindow, o.promptTokens, o.marginTokens);
  if (budget.clamped) o.onClamped(budget.maxTokens);
  const body: Record<string, unknown> = { max_tokens: budget.maxTokens };
  applyParams(body, o.params ?? null);
  return body;
}

/**
 * Грубая оценка числа токенов в сообщениях чата — сумма БАЙТ `content` (UTF-8) через
 * `BYTES_PER_TOKEN_ESTIMATE`.
 *
 * `Buffer.byteLength(text, 'utf8')`, а не `text.length`: `.length` строки — число UTF-16
 * code units, то есть для кириллицы это счёт СИМВОЛОВ, а не байт (кириллица — 2 байта на
 * символ в UTF-8, 1 code unit в UTF-16). Промпты этого проекта по конвенции на русском
 * (`CLAUDE.md`) — счёт символов вместо байт систематически занижал оценку на живом
 * прогоне: 3 поля дозаполнения `FormFillExecutor` подряд получили от LM Studio «Context
 * size has been exceeded» на запросе, который `paramsFor` перед отправкой посчитал ещё
 * влезающим — `max_tokens` был выдан по заниженной оценке остатка окна (bench-серия v5,
 * sweep5v5-qwen-refuse-dangerous, 2026-09-14). Тот же класс ошибки, что уже пойман для
 * `\b` в регулярках (`CLAUDE.md` → «Особенности…») — ASCII-предположение, не работающее
 * на кириллице.
 */
export function estimateMessageTokens(messages: readonly { content: string }[]): number {
  const bytes = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, 'utf8'), 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}
