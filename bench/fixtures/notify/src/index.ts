/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export type { OutMessage } from './message.ts';

export { memoryTransport } from './transport.ts';
export type { Transport } from './transport.ts';

export { sendNotification } from './sender.ts';

export { createOutbox } from './outbox.ts';
export type { Outbox } from './outbox.ts';

export { events, logEvent, resetLog } from './log.ts';
