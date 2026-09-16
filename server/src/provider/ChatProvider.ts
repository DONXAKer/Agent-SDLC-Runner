/**
 * Провайдер чата для флоу `loop`.
 *
 * Флоу `sdk` сюда не заходит: там цикл крутит Agent SDK. Здесь — минимум, которого хватает
 * методологии: сообщения, инструменты, ответ с вызовами инструментов и расход.
 *
 * Стриминг сознательно не заводим. Локальная модель на 4B отвечает секунды, а не минуты,
 * и польза от посимвольного вывода не окупает второй путь разбора ответа — тот самый, где
 * два флоу и расходятся.
 */

import type { Usage } from '@sdlc-runner/shared';

export interface ChatToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatToolCall {
  id: string;
  name: string;
  /** Аргументы уже разобраны. Модель вернула не-JSON — это `null`, и цикл говорит ей об этом. */
  arguments: Record<string, unknown> | null;
  /** Исходная строка аргументов: нужна в диагностике, когда разбор не удался. */
  rawArguments: string;
}

export type FinishReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ChatTurn {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatToolDef[];
  signal: AbortSignal;
  /**
   * Температура. `null` — не отправлять поле вовсе: у части серверов «не задано» и «0»
   * ведут себя по-разному, и подставлять своё значение молча нельзя.
   */
  temperature: number | null;
  /**
   * Сырые поля тела запроса из конфига модели (`ModelDef.params`): temperature,
   * max_tokens, top_p, seed, response_format, tool_choice и прочее, что понимает сервер.
   *
   * Одно generic-поле вместо ручки на каждый параметр: журнал замеров требует менять
   * «одну настройку за прогон», и каждая новая ручка иначе означала бы правку кода.
   * Служебные ключи (model, messages, tools, stream) слиянием не перекрываются —
   * их подмена ломала бы разбор ответа, а не поведение модели.
   */
  params?: Record<string, unknown> | null;
}

export interface ChatProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatTurn>;
}

/**
 * Параметры из конфига модели (`ModelDef.params`) — поверх собранного тела запроса:
 * оператор сознательно перекрывает наши умолчания (temperature, max_tokens, tool_choice,
 * response_format, seed…). Служебные ключи не отдаются: их подмена ломала бы разбор
 * ответа, а не поведение модели, — `stream: true` молча оставил бы раннер ждать конца
 * несобираемого ответа, а подменённые `messages` разошлись бы с показанным оператору
 * промптом.
 *
 * Живёт здесь, а не в конкретном провайдере: правило «явный конфиг перекрывает
 * вычисленное умолчание» нужно и составителю тела запроса (`OpenAiCompatProvider`), и
 * составителю САМИХ `params` до запроса (`LoopExecutor.paramsFor` — `max_tokens` по
 * остатку окна). Раньше второй реализовывал то же правило вручную отдельным спредом —
 * два места, знающие одну и ту же формулу, разошлись бы при первой же правке приоритета
 * (code-review-all, 2026-09-11).
 */
export function applyParams(body: Record<string, unknown>, params: Record<string, unknown> | null): void {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === 'model' || key === 'messages' || key === 'tools' || key === 'stream') continue;
    body[key] = value;
  }
}

/**
 * Отказ СРЕДЫ, а не модели: апстрим ответил 5xx/429 после всех повторов, оборвал
 * соединение или не ответил за таймаут.
 *
 * Отдельный тип нужен ровно для одного — чтобы такой сбой не красил модель. Замер
 * 2026-09-04 (14 витков `polza:ministral-14b` по семействам фикстур) показал цену смешения:
 * пять прогонов встали на 503 полза-апстрима, ошибка ушла в заметку «поле не спрошено»,
 * этап отчитался `ok`, и bench вернул код 1 — «модель не прошла» — там, где по конвенции
 * `bench/README.md` полагается 2, «измерение не состоялось». По строке сообщения это не
 * разобрать: `HTTP 503` и «ответ не разобрался как JSON» приходят одним `Error`.
 */
export class ProviderEnvError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderEnvError';
  }
}

/**
 * Подстроки живого падения движка провайдера (LM Studio упал посреди генерации или
 * недоступен) — общий источник для ДВУХ независимых потребителей с разными данными и
 * разной целью: `OpenAiCompatProvider` матчит по разобранному полю `error` тела HTTP-
 * ответа, чтобы классифицировать `ProviderEnvError`; `FormFillExecutor` матчит по тексту
 * уже брошенного исключения, чтобы поставить диагноз человеку при систематическом отказе.
 * Раньше — два регэкспа с одними и теми же двумя подстроками, продублированными вручную;
 * найдено и объединено этим же приёмом, что `applyParams` выше (code-review-all,
 * 2026-09-14). Каждый потребитель по-прежнему добавляет СВОИ дополнительные признаки
 * (сетевые коды, `econnrefused`) — общая часть только эта.
 *
 * Слова привязаны к границам: без них «Unterminated string in JSON at position 812» —
 * обычный отказ разбора, то есть про МОДЕЛЬ — совпадал с `terminated` и уходил в
 * средовой класс, а `FormFillExecutor` ставил диагноз «модель недоступна» (code-review,
 * 2026-09-14). `\b` здесь честен: оба слова латиница. Регулярка без флагов и групп
 * захвата намеренно — `FormFillExecutor` вклеивает её `.source` в свою через `|`.
 */
export const ENGINE_UNAVAILABLE_SUBSTRINGS = /\bterminated\b|\bfetch failed\b/i;

/**
 * OpenRouter и агрегаторы поверх него (`polza` — тот же `"provider":"openrouter"` в теле
 * успешного ответа) отдают structured `HTTP 400
 * {"error":{"code":"BAD_REQUEST","message":"All providers have been ignored…"}}`, когда ни
 * один апстрим-хост модели маршруту временно не подходит — не про сам запрос, а про ёмкость
 * маршрута в моменте. Живой замер (серия `sweep5-ministral14b`, 2026-09-16,
 * `docs/model-runs.md`): у `mistralai/ministral-14b-2512` на polza ровно один провайдер без
 * резерва, и 9 из 10 прогонов подряд упёрлись в эту ошибку на `intent`/`explore`, не
 * восстановившись до конца этапа — до фикса это красило МОДЕЛЬ (`envFailure` не
 * заполнялся), хотя отказ целиком средовой.
 *
 * Матчится ТОЛЬКО вместе с `error.code === 'BAD_REQUEST'` (см. `OpenAiCompatProvider`), а
 * не по сырому телу целиком: фраза достаточно необычна, чтобы не путать её со случайной
 * цитатой внутри сообщения об ошибке схемы инструмента — тот же риск ложного срабатывания,
 * что уже поймал `ENGINE_UNAVAILABLE_SUBSTRINGS` на `fetch failed` (code-review-all,
 * 2026-09-14), поэтому здесь та же осторожность, а не слепой матч по `error.message`.
 */
export const PROVIDER_ROUTING_EXHAUSTED_SUBSTRINGS = /\ball providers have been ignored\b/i;
