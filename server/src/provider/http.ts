/**
 * Общая обвязка служебных GET/POST к собственным (не OpenAI-совместимым) эндпойнтам
 * локальных серверов: `/api/tags`/`/api/show` у Ollama, `/api/v0/models` у LM Studio.
 *
 * Жила копией в двух модулях проверки окна (`ollamaContext.ts`, `lmstudioContext.ts`), и
 * копии уже разошлись в главном: ни у одной не было таймаута. Сервер, ушедший в своп, не
 * закрывает соединение — преполёт, обещающий секунды, висел бы до отмены оператором
 * (code-review, 2026-09-14).
 *
 * Модуль НЕ формирует текст для человека целиком: имя сервиса и подсказка запуска у
 * потребителей свои. Он отдаёт КЛАСС сбоя — потребителю нужно различать «эндпойнта здесь
 * нет» (прокси с одним `/v1`) и «сервер есть, но болен», а по строке сообщения этого не
 * разобрать.
 */

/** `http://localhost:11434/v1` → `http://localhost:11434` — общий хост для `/api/*`. */
export function apiOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/** Потолок служебного запроса: ответ на список моделей — миллисекунды, не минуты. */
export const API_FETCH_TIMEOUT_MS = 10_000;

export type FetchJsonFailure =
  | { kind: 'network'; detail: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'http'; status: number }
  | { kind: 'json' };

export type FetchJsonResult = { ok: true; body: unknown } | { ok: false; failure: FetchJsonFailure };

export interface FetchJsonOptions {
  init?: RequestInit;
  /** Внешняя отмена; складывается с собственным таймаутом. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchJson(url: string, o: FetchJsonOptions = {}): Promise<FetchJsonResult> {
  const timeoutMs = o.timeoutMs ?? API_FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal === undefined ? timeout : AbortSignal.any([o.signal, timeout]);
  let res: Response;
  try {
    res = await fetch(url, { ...(o.init ?? {}), signal });
  } catch (e) {
    // Таймаут — своим именем: reject несёт безликое «This operation was aborted», и
    // зависший сервер читался бы сетевым отказом без причины.
    if (timeout.aborted) return { ok: false, failure: { kind: 'timeout', timeoutMs } };
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, failure: { kind: 'network', detail: why } };
  }
  if (!res.ok) {
    // Тело не нужно, но незачитанный ответ держит сокет keep-alive до сборки мусора.
    await res.body?.cancel().catch(() => {});
    return { ok: false, failure: { kind: 'http', status: res.status } };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    // Таймаут может сработать и посреди чтения тела — это не «вернул не JSON».
    if (timeout.aborted) return { ok: false, failure: { kind: 'timeout', timeoutMs } };
    return { ok: false, failure: { kind: 'json' } };
  }
}

/**
 * Текст сбоя для оператора. `service` — имя сервера в сообщении, `startHint` — команда
 * запуска, которую стоит проверить при HTTP-ошибке.
 */
export function describeFetchFailure(url: string, f: FetchJsonFailure, service: string, startHint: string): string {
  switch (f.kind) {
    case 'network':
      return `${service}: нет ответа по ${url} — ${f.detail}`;
    case 'timeout':
      return `${service}: ${url} не ответил за ${f.timeoutMs} мс — таймаут (сервер завис или ушёл в своп?)`;
    case 'http':
      return `${service}: ${url} ответил HTTP ${f.status} — сервер запущен (${startHint})?`;
    case 'json':
      return `${service}: ${url} вернул не JSON`;
  }
}
