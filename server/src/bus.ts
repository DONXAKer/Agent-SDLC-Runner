/**
 * Шина событий прогона.
 *
 * События буферизуются по прогонам: клиент, подключившийся посреди этапа, должен увидеть
 * всё, что уже произошло, а не начать с середины. Иначе панель промпта и очередь одобрений
 * оказываются пустыми ровно тогда, когда они нужнее всего.
 *
 * Буфер ограничен и по числу записей, и по объёму. События здесь не мелкие: `tool_request`
 * несёт полный текст «до» и «после» каждого записываемого файла, `prompt_prepared` — весь
 * системный и пользовательский промпт. Этап chunk, десять раз переписавший файл на 200 КБ,
 * иначе держал бы мегабайты в истории давно завершённого витка, а локальный сервис живёт
 * неделями между перезапусками.
 */

import type { RunEvent } from '@sdlc-runner/shared';

const MAX_EVENTS = 2000;
const MAX_BYTES = 8 * 1024 * 1024;

interface Buffered {
  events: RunEvent[];
  bytes: number;
}

/** Дешёвая оценка веса события: точный размер тут не нужен, нужен порядок величины. */
function weigh(e: RunEvent): number {
  switch (e.type) {
    case 'tool_request':
      return (e.preview?.before?.length ?? 0) + (e.preview?.after.length ?? 0) + 512;
    case 'prompt_prepared':
      return e.prompt.system.length + e.prompt.user.length + 512;
    case 'assistant_text':
    case 'thinking':
      return e.text.length + 128;
    default:
      return 256;
  }
}

export class EventBus {
  private readonly subscribers = new Set<(e: RunEvent) => void>();
  private readonly history = new Map<string, Buffered>();

  emit(e: RunEvent): void {
    const runId = 'runId' in e ? e.runId : null;
    if (runId !== null) {
      const buf = this.history.get(runId) ?? { events: [], bytes: 0 };
      buf.events.push(e);
      buf.bytes += weigh(e);

      // Обрезаем с начала: свежие события ценнее для догоняющего клиента.
      while (buf.events.length > MAX_EVENTS || buf.bytes > MAX_BYTES) {
        const dropped = buf.events.shift();
        if (dropped === undefined) break;
        buf.bytes -= weigh(dropped);
      }

      this.history.set(runId, buf);
    }

    for (const s of this.subscribers) {
      try {
        s(e);
      } catch {
        // Умерший подписчик не должен ронять прогон.
      }
    }
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  replay(runId: string): RunEvent[] {
    return [...(this.history.get(runId)?.events ?? [])];
  }

  forget(runId: string): void {
    this.history.delete(runId);
  }
}
