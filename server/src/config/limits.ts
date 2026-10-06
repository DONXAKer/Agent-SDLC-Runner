/**
 * Производные лимиты раннера. Одна функция на правило, которое иначе повторялось бы по месту
 * вызова: смена правила, пропустившая одно место из десяти, разводит срезы, обещанные
 * комментариями «тот же потолок».
 */

import type { LoadedConfig } from './load.ts';

/**
 * Потолок результата инструмента и всякого среза, конкурирующего с ним за окно локальной
 * модели (срез патча, карточки разведки, фрагмент хунка): общий потолок рассчитан на большое
 * окно, а один `Read` по нему забирал почти весь контекст 16K — измерено на прогоне.
 */
export function localResultBytes(limits: LoadedConfig['runner']['limits']): number {
  return Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes);
}

/**
 * Умолчание потолка одного запроса этапа `explore` — единственный источник числа:
 * `LIMIT_DEFAULTS` (`config/load.ts`) и запасная подстановка в `exploreChatTimeoutMs`
 * (для конфигов, собранных в тестах мимо загрузчика) обязаны ссылаться на него, а не
 * держать по своей копии.
 */
export const EXPLORE_REQUEST_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * Потолок одного запроса к модели на этапе `explore`: не выше общего `chatTimeoutMs`,
 * а при заданном `exploreRequestTimeoutMs` — и не выше него.
 *
 * Отдельная от бюджетов прогона ручка: запрос разведки ограничен по объёму (карточка
 * файла), а разбор прогона 2026-10-05 показал два ~300-секундных висения, съевших
 * две трети 12-минутного бюджета этапа при общем `chatTimeoutMs` 600 с. Запрос дольше
 * этого потолка обрывается (`AbortSignal.timeout` в `OpenAiCompatProvider`) с отказом
 * «таймаут запроса», видимым в событиях и метриках этапа.
 */
export function exploreChatTimeoutMs(limits: LoadedConfig['runner']['limits']): number {
  return Math.min(limits.chatTimeoutMs, limits.exploreRequestTimeoutMs ?? EXPLORE_REQUEST_TIMEOUT_DEFAULT_MS);
}
