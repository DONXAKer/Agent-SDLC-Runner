/**
 * Идемпотентность отправки.
 *
 * Вызывающая сторона ретраит по таймауту и шлёт то же уведомление ещё раз (а то и
 * трижды): повторный вызов с тем же idempotencyKey не должен уходить в транспорт
 * повторно и возвращает прежний id — тот, что выдал транспорт при первой отправке.
 */

import { strictEqual, deepStrictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryTransport, sendNotification } from '../src/index.ts';

describe('идемпотентность отправки', () => {
  it('повтор с тем же ключом не отправляет повторно и возвращает прежний id', () => {
    const t = memoryTransport();
    const msg = { to: 'anna@example.ru', text: 'Заказ собран' };
    const first = sendNotification(t, msg, { idempotencyKey: 'order-1' });
    const second = sendNotification(t, msg, { idempotencyKey: 'order-1' });
    const third = sendNotification(t, msg, { idempotencyKey: 'order-1' });
    strictEqual(t.sent.length, 1, 'в транспорт ушло ровно одно сообщение');
    strictEqual(first.id, 'mem-1');
    strictEqual(second.id, 'mem-1');
    strictEqual(third.id, 'mem-1');
  });

  it('повтор с тем же ключом, но другим телом — исключение, в транспорт не уходит', () => {
    const t = memoryTransport();
    sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'order-2' });
    const variants = [
      { to: 'anna@example.ru', text: 'Заказ готов' },
      { to: 'boris@example.ru', text: 'Заказ собран' },
      { to: 'anna@example.ru', text: 'Заказ собран', phone: '+79001112233' },
    ];
    for (const msg of variants) {
      throws(
        () => sendNotification(t, msg, { idempotencyKey: 'order-2' }),
        'различное тело под одним ключом — ошибка вызывающего',
      );
    }
    strictEqual(t.sent.length, 1, 'чужое тело не отправляется');
    // Прежний id по-прежнему вернётся при повторе с исходным телом.
    const again = sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'order-2' });
    strictEqual(again.id, 'mem-1');
    strictEqual(t.sent.length, 1);
  });

  it('разные ключи — независимые отправки', () => {
    const t = memoryTransport();
    const first = sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'a' });
    const second = sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'b' });
    strictEqual(t.sent.length, 2);
    strictEqual(first.id, 'mem-1');
    strictEqual(second.id, 'mem-2');
  });

  it('вызов без ключа всегда отправляет, даже то же самое тело', () => {
    const t = memoryTransport();
    const msg = { to: 'anna@example.ru', text: 'Заказ собран' };
    const first = sendNotification(t, msg);
    const second = sendNotification(t, msg);
    deepStrictEqual(first, { id: 'mem-1' });
    deepStrictEqual(second, { id: 'mem-2' });
    strictEqual(t.sent.length, 2);
  });

  it('одинаковое тело с ключом и без: повтор без ключа отправляет заново', () => {
    const t = memoryTransport();
    const msg = { to: 'anna@example.ru', text: 'Заказ собран' };
    sendNotification(t, msg, { idempotencyKey: 'key' });
    const plain = sendNotification(t, msg);
    strictEqual(plain.id, 'mem-2');
    strictEqual(t.sent.length, 2);
    // А повтор по ключу — прежний id.
    strictEqual(sendNotification(t, msg, { idempotencyKey: 'key' }).id, 'mem-1');
  });
});
