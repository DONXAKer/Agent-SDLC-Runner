/**
 * Транспорт.
 *
 * Сети здесь нет: транспорт — интерфейс, а единственная реализация в репозитории —
 * памятная, для тестов. Транспорт доставляет и выдаёт id отправки; правила отправки
 * (кому, когда, сколько раз) — не его забота, они лежат выше, у отправителя и очереди.
 */

import type { OutMessage } from './message.ts';

export interface Transport {
  /** Доставить сообщение. Возвращает id отправки, присвоенный транспортом. */
  send(msg: OutMessage): string;
}

/**
 * Памятный транспорт — стенд для тестов: всё «отправленное» лежит в `sent`, id выдаются
 * подряд от единицы. Счётчик свой на каждый экземпляр, чтобы тесты не зависели от порядка
 * запуска друг друга.
 */
export function memoryTransport(): Transport & { sent: OutMessage[] } {
  const sent: OutMessage[] = [];
  let nextId = 1;
  return {
    sent,
    send(msg: OutMessage): string {
      sent.push(msg);
      const id = `mem-${nextId}`;
      nextId += 1;
      return id;
    },
  };
}
