/**
 * Тесты идемпотентной отправки.
 *
 * Повторный вызов с тем же ключом повторно не отправляет — отдаёт прежний id. Ключ не
 * должен протекать в транспорт, «как было» для вызовов без ключа не ломается, а «один
 * ключ — одно тело» — ошибка при других данных.
 */

import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryTransport, sendNotification, resetLog } from '../src/index.ts';
import type { OutMessage } from '../src/message.ts';

describe('идемпотентная отправка', () => {

  it('ретрай с тем же ключом не шлёт повторно и возвращает прежний id', () => {
    const t = memoryTransport();
    const msg: OutMessage = { to: 'anna@example.ru', text: 'Заказ собран' };
    const first = sendNotification(t, msg, { idempotencyKey: 'k-1' });
    const second = sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'k-1' });
    strictEqual(first.id, 'mem-1');
    strictEqual(second.id, 'mem-1');
    strictEqual(t.sent.length, 1);
    deepStrictEqual(t.sent[0], msg);
  });

  it('ретрай передаёт ровно то же сообщение, что и первый вызов', () => {
    const t = memoryTransport();
    const msg: OutMessage = { to: 'anna@example.ru', text: 'Заказ собран', phone: '+79001112233' };
    sendNotification(t, msg, { idempotencyKey: 'k-phone' });
    sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран', phone: '+79001112233' }, { idempotencyKey: 'k-phone' });
    strictEqual(t.sent.length, 1);
    deepStrictEqual(t.sent[0], msg);
  });

  it('повтор с тем же ключом и другим сообщением — исключение, в транспорт ничего', () => {
    const t = memoryTransport();
    const base: OutMessage = { to: 'anna@example.ru', text: 'Заказ собран' };
    const first = sendNotification(t, base, { idempotencyKey: 'k-err' });
    strictEqual(first.id, 'mem-1');

    // Меняется `to`:
    try {
      sendNotification(t, { to: 'boris@example.ru', text: 'Заказ собран' }, { idempotencyKey: 'k-err' });
      strictEqual(true, false, 'должно было бросить исключение');
    } catch (e) {
      ok(e instanceof Error);
    }
    // Меняется `text`:
    try {
      sendNotification(t, { to: 'anna@example.ru', text: 'Другое' }, { idempotencyKey: 'k-err' });
      strictEqual(true, false, 'должно было бросить исключение');
    } catch (e) {
      ok(e instanceof Error);
    }
    // Меняется `phone` (был undefined → теперь установлен):
    try {
      sendNotification(t, { to: 'anna@example.ru', text: 'Заказ собран', phone: '+79001112233' }, { idempotencyKey: 'k-err' });
      strictEqual(true, false, 'должно было бросить исключение');
    } catch (e) {
      ok(e instanceof Error);
    }
    strictEqual(t.sent.length, 1);
    // Исходный id при повторном обращении — тот же:
    strictEqual(sendNotification(t, base, { idempotencyKey: 'k-err' }).id, first.id);
  });

  it('разные ключи — независимые отправки', () => {
    const t = memoryTransport();
    const a = sendNotification(t, { to: 'anna@example.ru', text: 'Текст А' }, { idempotencyKey: 'a' });
    const b = sendNotification(t, { to: 'anna@example.ru', text: 'Текст А' }, { idempotencyKey: 'b' });
    strictEqual(a.id, 'mem-1');
    strictEqual(b.id, 'mem-2');
    strictEqual(t.sent.length, 2);
  });

  it('вызов без ключа — всегда отправляет, даже если сообщение уже было отправлено', () => {
    const t = memoryTransport();
    const msg: OutMessage = { to: 'anna@example.ru', text: 'Заказ собран' };
    const first = sendNotification(t, msg, { idempotencyKey: 'no-key-retest' });
    const second = sendNotification(t, msg);
    const third = sendNotification(t, msg);
    strictEqual(first.id, 'mem-1');
    strictEqual(second.id, 'mem-2');
    strictEqual(third.id, 'mem-3');
    strictEqual(t.sent.length, 3);
  });

  it('ключ живёт на процесс: повторный вызов с тем же ключом — в новом транзакционном контексте — не пересылает', () => {
    // memoryTransport — стенд со своим счётчиком на экземпляр.
    // Здесь ключ из-за одного прогоня, а транспорт — новый: идемпотентность держит ключ + id,
    // а не транспорт. Новый транспорт не должен «размазывать» существующие ключи.
    const t1 = memoryTransport();
    const msg: OutMessage = { to: 'anna@example.ru', text: 'Заказ собран' };
    const id1 = sendNotification(t1, msg, { idempotencyKey: 'across-transport' }).id;
    const t2 = memoryTransport();
    const id2 = sendNotification(t2, msg, { idempotencyKey: 'across-transport' }).id;
    strictEqual(id1, 'mem-1');
    strictEqual(id2, 'mem-1'); // не mem-1 нового транспорта — прежний
    strictEqual(t2.sent.length, 0);
  });
});
