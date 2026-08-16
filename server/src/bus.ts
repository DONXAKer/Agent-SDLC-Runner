/**
 * Шина событий прогона.
 *
 * События буферизуются по прогонам: клиент, подключившийся посреди этапа, должен увидеть
 * всё, что уже произошло, а не начать с середины. Иначе панель промпта и очередь одобрений
 * оказываются пустыми ровно тогда, когда они нужнее всего.
 */

import type { RunEvent } from './types.ts';

const MAX_BUFFERED = 2000;

export class EventBus {
  private readonly subscribers = new Set<(e: RunEvent) => void>();
  private readonly history = new Map<string, RunEvent[]>();

  emit(e: RunEvent): void {
    const runId = 'runId' in e ? e.runId : null;
    if (runId !== null) {
      const list = this.history.get(runId) ?? [];
      list.push(e);
      // Обрезаем с начала: свежие события ценнее для догоняющего клиента.
      if (list.length > MAX_BUFFERED) list.splice(0, list.length - MAX_BUFFERED);
      this.history.set(runId, list);
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
    return [...(this.history.get(runId) ?? [])];
  }

  forget(runId: string): void {
    this.history.delete(runId);
  }
}
