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
 * Доля окна, отдаваемая под результаты инструментов в истории хода (`historyBudgetFor`).
 * Остаток — системный промпт этапа, вопрос/ответ текущего хода и запас `marginFor`.
 */
const HISTORY_BUDGET_WINDOW_FRACTION = 0.4;

/**
 * Бюджет истории (`server/src/run/Run.ts` → `LoopExecutor.historyBudgetBytes`) по окну
 * маршрута, а не только фиксированный `limits.localHistoryBudgetBytes` (умолчание
 * 40 000 байт ≈ 10 000 токенов).
 *
 * Найдено серией local6 (2026-09-24): на маршруте с окном 16 384 (`ollama:qwen3.8-27b`)
 * фиксированные 40 000 байт истории + ~4 000 токенов системного промпта + запас
 * `marginFor` уже сами по себе превышали окно — `max_tokens` садился на пол 256 на
 * ПЕРВОМ ходу этапа, до того как модель успевала хоть что-то сделать. Формула даёт
 * меньший бюджет только узким окнам (16 384 → 26 214 байт); от 32 768 и выше бюджет
 * не меняется — `Math.min` с прежним умолчанием гарантирует, что модели с большим
 * окном не станет хуже.
 */
export function historyBudgetFor(contextWindow: number, defaultBudgetBytes: number): number {
  const byWindow = Math.floor(contextWindow * BYTES_PER_TOKEN_ESTIMATE * HISTORY_BUDGET_WINDOW_FRACTION);
  return Math.min(defaultBudgetBytes, byWindow);
}

/**
 * Сколько последних результатов инструментов `trimHistory` держит целиком, невзирая на
 * бюджет (`exec/history.ts::HISTORY_KEEP_LAST` — умолчание, когда бюджет НЕ сужен).
 *
 * На бюджете, суженном по узкому окну (`historyBudgetFor`, Р1), фиксированное число
 * результатов по `maxResultBytes` каждый способно само занять весь урезанный бюджет
 * (3 × 12 000 = 36 000 байт против бюджета 26 214 на окне 16 384) — `trimHistory` тогда
 * не достигла бы бюджета уже по построению на КАЖДОМ ходу, хотя формально отработала:
 * `NEVER_STUB` и последние `keepLast` результатов не режутся никогда. Пол в один
 * результат — не удерживать вообще нечего было бы только при пустой истории.
 */
export function historyKeepLastFor(
  historyBudgetBytes: number | undefined,
  maxResultBytes: number,
  defaultKeepLast: number,
): number {
  if (historyBudgetBytes === undefined) return defaultKeepLast;
  const fitBudget = Math.floor(historyBudgetBytes / maxResultBytes);
  return Math.max(1, Math.min(defaultKeepLast, fitBudget));
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
  /**
   * `ModelDef.params`: явный `max_tokens` оператора — ПОТОЛОК поверх вычисленного, а не
   * замена (см. `budgetParams`). Остальные ключи по-прежнему уходят как есть.
   */
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
 * Явный `params.max_tokens` — ПОТОЛОК, а не замена вычисленного: `min(explicit, computed)`.
 * До этой правки (найдено серией local6, 2026-09-24) `applyParams` копировал явное число
 * безусловно — запись `ollama:granite4.2-8b-ctx32k-mt` (`max_tokens: 16384`, окно не
 * заявлено) держала явную цифру и без окна отключала расчёт полностью (см. `contextWindow
 * === undefined` ниже — это остаётся так специально, менять окно и явное число сразу значило
 * бы менять ДВЕ ручки одним коммитом), а запись с ОКНОМ, где явное число заведомо больше
 * реального остатка (`glm-4.7-flash`: окно 16384, `max_tokens` тоже 16384), получала точно
 * такой же неограниченный потолок — расчёт остатка существовал и был отброшен тем же ходом.
 * Семантика «модель не выдаст больше N» у явного числа сохраняется, просто теперь она не
 * может РАЗРЕШИТЬ больше, чем позволяет окно.
 */
export function budgetParams(o: BudgetParamsInput): Record<string, unknown> | null {
  if (o.contextWindow === undefined) return o.params ?? null;
  const budget = maxTokensForRemaining(o.contextWindow, o.promptTokens, o.marginTokens);
  if (budget.clamped) o.onClamped(budget.maxTokens);
  const explicit = o.params?.['max_tokens'];
  const maxTokens = typeof explicit === 'number' ? Math.min(explicit, budget.maxTokens) : budget.maxTokens;
  const body: Record<string, unknown> = { max_tokens: maxTokens };
  applyParams(body, o.params ?? null);
  // `applyParams` только что скопировал явный `max_tokens` как есть (он не различает это
  // поле от прочих) — переопределяем итоговым значением ПОСЛЕ неё.
  body['max_tokens'] = maxTokens;
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
