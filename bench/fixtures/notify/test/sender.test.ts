/**
 * Тесты отправителя.
 *
 * Отправка без опций: уведомление доходит до транспорта как есть, id — тот, что выдал
 * транспорт. Вызовы здесь намеренно без ключей, приоритетов и прочих опций — это контракт
 * «как было», и он обязан остаться законным.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryTransport, sendNotification } from '../src/index.ts';

describe('отправитель', () => {
  it('уведомление доходит до транспорта как есть', () => {
    const t = memoryTransport();
    const msg = { to: 'anna@example.ru', text: 'Заказ собран' };
    sendNotification(t, msg);
    strictEqual(t.sent.length, 1);
    deepStrictEqual(t.sent[0], msg);
  });

  it('id отправки — тот, что выдал транспорт', () => {
    const t = memoryTransport();
    const first = sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' });
    const second = sendNotification(t, { to: 'boris@example.ru', text: 'Заказ выдан', phone: '+79001112233' });
    strictEqual(first.id, 'mem-1');
    strictEqual(second.id, 'mem-2');
    strictEqual(t.sent.length, 2);
  });
});
