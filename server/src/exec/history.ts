/**
 * Обрезка истории хода для флоу `loop`: скользящее окно по результатам инструментов.
 *
 * Зачем: до этой функции история сообщений в `LoopExecutor.run` только росла — ни
 * удаления старых результатов, ни суммаризации. Потолок был на результат ОДНОГО вызова
 * (`localMaxToolResultBytes`, 12 КБ), и десять вызовов давали 120 КБ поверх промпта этапа
 * на каждом следующем ходе. Замер (`docs/model-runs.md`, r33): 31 вызов → 367 000 входных
 * токенов при объявленном окне 16k. Локальный сервер при переполнении не отказывает — он
 * молча вытесняет НАЧАЛО, то есть системный промпт с методологией и правилами; отсюда
 * наблюдавшиеся «вернуться на `/sdlc-plan`» и «`/sdlc-verify`» текстом вместо работы.
 *
 * Что режется и что нет:
 *  - режутся только сообщения `tool` — содержимое результата заменяется заглушкой с
 *    именем инструмента, первой строкой исходного результата и размером. Первая строка
 *    оставлена нарочно: у `Write`/`Edit` это «создан src/x.ts (16 строк)», и модель
 *    по-прежнему видит, ЧТО она сделала, — теряется только текст, который она и так
 *    должна перечитать после своей правки;
 *  - результаты ТЕКУЩЕГО хода (после последнего ответа модели) не трогаются никогда:
 *    модель их ещё не видела, и заглушка «перечитай файл» на них гоняла бы её по кругу;
 *  - последние `keepLast` результатов не трогаются: правка, которую модель только что
 *    сделала, и её ответ обязаны быть перед глазами целиком;
 *  - ответы человека (`AskHuman`) не трогаются никогда: повторить вызов нельзя (повтор с
 *    теми же аргументами — «уже был»), и стёртый ответ — ровно «потерянный ответ
 *    человека», ради которого заведён `humanFactsBlock`;
 *  - `system`, `user` и `assistant` не трогаются: промпт этапа режется при сборке
 *    (`prompt/build.ts`), а не здесь — второе место со своим знанием о потолке разошлось
 *    бы с первым.
 *
 * Функция чистая: исходный массив не меняется, возвращается представление для запроса.
 * Полная история остаётся у цикла — анти-цикл и отпечатки вызовов считаются по ней.
 * Заглушка детерминирована, поэтому на ходах без новых заглушек префикс запроса не
 * меняется; каждая НОВАЯ заглушка меняет префикс и роняет KV-кэш локального сервера —
 * цена, которую стоит замерить отдельно (не измерено).
 */

import type { ChatMessage } from '../provider/ChatProvider.ts';

/** Сколько последних результатов инструментов держится целиком при любом бюджете. */
export const HISTORY_KEEP_LAST = 3;

/** Инструменты, результат которых не заменяется заглушкой никогда. */
const NEVER_STUB: ReadonlySet<string> = new Set(['AskHuman']);

const STUB_MARK = '[история сокращена рантаймом:';

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function stubFor(m: ChatMessage & { role: 'tool' }): string {
  const firstLine = m.content.split('\n')[0]?.slice(0, 160) ?? '';
  return (
    `${firstLine}\n…${STUB_MARK} результат «${m.name}» на ${bytes(m.content)} байт убран из ` +
    `контекста; если содержимое нужно снова — перечитай файл или повтори вызов с другими аргументами]`
  );
}

/**
 * Возвращает историю, в которой суммарный объём результатов инструментов не превышает
 * `budgetBytes` — НАСКОЛЬКО это вообще достижимо сокращением заглушками. Заглушки ставятся
 * от самого старого результата к новым; результат, который сам меньше своей заглушки, не
 * трогается — иначе «сокращение» росло бы.
 *
 * Гарантии тут нет: `NEVER_STUB` (ответы человека) и последние `keepLast` результатов не
 * трогаются НИКОГДА, и если их сумма сама превышает бюджет, вернувшаяся история всё ещё
 * будет больше него — та самая проблема «локальный сервер молча вытесняет системный
 * промпт», ради которой функция и написана, воспроизводится снова именно в этом случае.
 * `onOverBudget` вызывается ровно тогда — вызывающий (у него есть `hooks.onWarn`) решает,
 * что с этим сказать оператору; сама функция про I/O ничего не знает.
 */
export function trimHistory(
  messages: readonly ChatMessage[],
  budgetBytes: number,
  keepLast = HISTORY_KEEP_LAST,
  onOverBudget?: (totalBytes: number, budgetBytes: number) => void,
): ChatMessage[] {
  const toolIdx: number[] = [];
  let total = 0;
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant') lastAssistant = i;
    if (m.role === 'tool') {
      toolIdx.push(i);
      total += bytes(m.content);
    }
  });
  if (total <= budgetBytes) return [...messages];

  const out = [...messages];
  // Кандидаты на заглушку: не текущий ход, не последние `keepLast`, не ответ человека.
  const candidates = toolIdx
    .slice(0, Math.max(0, toolIdx.length - keepLast))
    .filter((i) => i < lastAssistant)
    .filter((i) => !NEVER_STUB.has((messages[i] as ChatMessage & { role: 'tool' }).name));
  for (const i of candidates) {
    if (total <= budgetBytes) break;
    const m = out[i] as ChatMessage & { role: 'tool' };
    if (m.content.includes(STUB_MARK)) continue;
    const stub = stubFor(m);
    const saved = bytes(m.content) - bytes(stub);
    if (saved <= 0) continue;
    out[i] = { ...m, content: stub };
    total -= saved;
  }
  if (total > budgetBytes) onOverBudget?.(total, budgetBytes);
  return out;
}

/** Сколько результатов инструментов в истории заменено заглушками — для тестов. */
export function stubbedCount(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === 'tool' && m.content.includes(STUB_MARK)).length;
}
