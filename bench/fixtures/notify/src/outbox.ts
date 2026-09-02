/**
 * Очередь исходящих.
 *
 * Уведомления накапливаются и уходят разом по `drain`. Очередь — объект, а не состояние
 * модуля: у каждого вызывающего своя, и тесты не делят одну очередь через общий импорт.
 * Порядок отдачи — порядок постановки: `drain` отправляет то, что накопилось, и ничего
 * не переставляет.
 */

import { logEvent } from './log.ts';
import type { OutMessage } from './message.ts';
import { sendNotification } from './sender.ts';
import type { Transport } from './transport.ts';

export interface Outbox {
  /** Поставить уведомление в очередь. Ничего не отправляет. */
  enqueue(msg: OutMessage): void;
  /** Отправить всё накопленное через транспорт. Возвращает id отправок в порядке отправки; очередь пустеет. */
  drain(transport: Transport): string[];
  /** Сколько уведомлений ждёт отправки. */
  pending(): number;
}

export function createOutbox(): Outbox {
  const queue: OutMessage[] = [];
  return {
    enqueue(msg: OutMessage): void {
      queue.push(msg);
    },
    drain(transport: Transport): string[] {
      const ids: string[] = [];
      for (const msg of queue) ids.push(sendNotification(transport, msg).id);
      queue.length = 0;
      // В журнал идёт счётчик, не адресаты: см. README, «персональные данные не пишутся».
      logEvent(`отправлено из очереди: ${ids.length}`);
      return ids;
    },
    pending(): number {
      return queue.length;
    },
  };
}
