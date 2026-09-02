/**
 * Отправитель.
 *
 * Тонкая обёртка над транспортом: одна точка, через которую уходит каждое уведомление.
 * Она нужна не ради строки кода, а ради места — правила отправки, когда появятся, встанут
 * сюда, а не размажутся по вызывающим.
 */

import type { OutMessage } from './message.ts';
import type { Transport } from './transport.ts';

/** Отправить одно уведомление. Возвращает id отправки, выданный транспортом. */
export function sendNotification(transport: Transport, msg: OutMessage): { id: string } {
  return { id: transport.send(msg) };
}
