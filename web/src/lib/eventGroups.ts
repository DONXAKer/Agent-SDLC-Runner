import type { RunEvent } from '@sdlc-runner/shared';

type ToolRequestEvent = Extract<RunEvent, { type: 'tool_request' }>;
type ToolResolvedEvent = Extract<RunEvent, { type: 'tool_resolved' }>;
type ToolResultEvent = Extract<RunEvent, { type: 'tool_result' }>;

/**
 * Итог вызова инструмента для однострочного отображения.
 *
 * `pending` — ждёт решения человека или политики, `running` — разрешён и исполняется.
 * Оба не имеют результата, но сворачивать `pending` в нейтральную строку нельзя:
 * «ждёт решения» обязано оставаться заметным.
 */
export type ToolCallStatus = 'pending' | 'running' | 'denied' | 'ok' | 'failed';

export type EventItem =
  | {
      kind: 'tool';
      request: ToolRequestEvent;
      resolved?: ToolResolvedEvent;
      result?: ToolResultEvent;
      status: ToolCallStatus;
    }
  | { kind: 'plain'; event: RunEvent };

/**
 * Сгруппировать тройки `tool_request → tool_resolved → tool_result` в один элемент.
 *
 * Группа встаёт на позицию `tool_request`, порядок остальных событий не меняется.
 * Осиротевшие `tool_resolved`/`tool_result` — без своего `tool_request` в ленте: буфер
 * шины вытесняет с начала — не теряются, а остаются отдельными строками.
 */
export function groupEvents(events: RunEvent[]): EventItem[] {
  const requests = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool_request') requests.add(e.requestId);
  }

  const resolvedBy = new Map<string, ToolResolvedEvent>();
  const resultBy = new Map<string, ToolResultEvent>();
  for (const e of events) {
    if (e.type === 'tool_resolved' && requests.has(e.requestId)) resolvedBy.set(e.requestId, e);
    if (e.type === 'tool_result' && requests.has(e.requestId)) resultBy.set(e.requestId, e);
  }

  const out: EventItem[] = [];
  for (const e of events) {
    if (e.type === 'tool_request') {
      const resolved = resolvedBy.get(e.requestId);
      const result = resultBy.get(e.requestId);
      // `denied` проверяется раньше `result`: в loop-флоу отклонённый вызов получает и
      // `tool_resolved(denied)`, и синтетический `tool_result(ok:false, summary=reason)`
      // — исполнитель обязан вернуть модели хоть какой-то результат на отклонённый вызов.
      // Если решать по `result` первым, отказ неотличим от настоящего падения инструмента.
      const status: ToolCallStatus =
        resolved !== undefined && !resolved.decision.allowed
          ? 'denied'
          : result !== undefined
            ? result.ok
              ? 'ok'
              : 'failed'
            : resolved !== undefined
              ? 'running'
              : 'pending';
      out.push({
        kind: 'tool',
        request: e,
        status,
        ...(resolved === undefined ? {} : { resolved }),
        ...(result === undefined ? {} : { result }),
      });
    } else if ((e.type === 'tool_resolved' || e.type === 'tool_result') && requests.has(e.requestId)) {
      // Поглощено группой своего запроса.
    } else {
      out.push({ kind: 'plain', event: e });
    }
  }
  return out;
}
