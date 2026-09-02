/**
 * Тесты очереди.
 *
 * Уведомления здесь без приоритетов и одному адресату не идут подряд: это покрытие
 * «enqueue → drain отдаёт всё в порядке постановки», и любое будущее правило очереди
 * обязано оставить этот случай как есть.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOutbox, memoryTransport } from '../src/index.ts';

describe('очередь исходящих', () => {
  it('enqueue накапливает, ничего не отправляя', () => {
    const box = createOutbox();
    box.enqueue({ to: 'anna@example.ru', text: 'Заказ собран' });
    box.enqueue({ to: 'boris@example.ru', text: 'Заказ выдан' });
    strictEqual(box.pending(), 2);
  });

  it('drain отправляет накопленное в порядке постановки и опустошает очередь', () => {
    const box = createOutbox();
    const t = memoryTransport();
    box.enqueue({ to: 'anna@example.ru', text: 'Заказ собран' });
    box.enqueue({ to: 'boris@example.ru', text: 'Заказ выдан' });
    const ids = box.drain(t);
    deepStrictEqual(ids, ['mem-1', 'mem-2']);
    deepStrictEqual(
      t.sent.map((m) => m.to),
      ['anna@example.ru', 'boris@example.ru'],
    );
    strictEqual(box.pending(), 0);
  });

  it('drain пустой очереди ничего не отправляет', () => {
    const box = createOutbox();
    const t = memoryTransport();
    deepStrictEqual(box.drain(t), []);
    strictEqual(t.sent.length, 0);
  });
});
