/**
 * Отправитель.
 *
 * Тонкая обёртка над транспортом: одна точка, через которую уходит каждое уведомление.
 * Она нужна не ради строки кода, а ради места — правила отправки, когда появятся, встанут
 * сюда, а не размажутся по вызывающим.
 */

import type { OutMessage } from './message.ts';
import type { Transport } from './transport.ts';

/** Опции отправки. Все необязательные: два аргумента — тот же «как было» контракт. */
export interface SendOptions {
  /**
   * Ключ идемпотентности. Повторный вызов с тем же ключом повторно не отправляет —
   * возвращает id первой отправки. Ключ живой до конца процесса; TTL не предполагается.
   */
  idempotencyKey?: string;
}

/**
 * Хранилище ключей идемпотентности: ключ → { id первой отправки, тело, с которым тот id
 * выдан }. В процессе, на весь модуль: ретрай того же вызова — это процесс, а не новый
 * рантайм. Тело храним, чтобы поймать «один ключ — другое тело», а не молча вернуть чужой
 * id.
 */
const keyRecords = new Map<string, { id: string; msg: OutMessage }>();

function sameMessage(a: OutMessage, b: OutMessage): boolean {
  return a.to === b.to && a.text === b.text && a.phone === b.phone;
}

/**
 * Отправить одно уведомление. Возвращает id отправки, выданный транспортом.
 *
 * С ключом идемпотентности (`idempotencyKey`): повторный вызов тем же ключом повторно
 * не отправляет — возвращается прежний id. Если с тем же ключом пришло другое сообщение
 * (отличается `to`, `text` или `phone`) — исключение: это ошибка вызывающего, и её не
 * следует маскировать тихим возвратом чужого id.
 */
export function sendNotification(transport: Transport, msg: OutMessage, opts?: SendOptions): { id: string } {
  if (opts?.idempotencyKey !== undefined) {
    const key = opts.idempotencyKey;
    const record = keyRecords.get(key);
    if (record) {
      if (!sameMessage(record.msg, msg)) {
        throw new Error(`идемпотентность: ключ ${key} уже использован с другим сообщением`);
      }
      return { id: record.id };
    }
    const id = transport.send(msg);
    keyRecords.set(key, { id, msg });
    return { id };
  }
  return { id: transport.send(msg) };
}
