/**
 * Эталон внешнего платёжного API — in-process мок банка.
 *
 * Мок реализует контракт из README РОВНО: змеиный регистр полей, сумма строкой, HTTP-статус
 * всегда 200, отказ — `ok:false` в теле. Это эталон поведения внешней системы: править его
 * под клиента — значит подогнать стенд, поэтому мок закрыт для правок в задачах.
 */

import type { HttpPost, HttpResponse } from './transport.ts';

/** Счётчик выданных charge_id — детерминированный, чтобы ответы были воспроизводимы. */
let nextChargeNum = 1024;

const CARDS: Readonly<Record<string, { ok: true } | { ok: false; code: string; message: string }>> = {
  tok_ok: { ok: true },
  tok_decline: { ok: false, code: 'insufficient_funds', message: 'недостаточно средств' },
  tok_fraud: { ok: false, code: 'fraud_suspected', message: 'подозрение на мошенничество' },
};

/** Банк как транспорт: принимает путь и тело строкой, отвечает по контракту. */
export function mockBank(): HttpPost {
  return (path: string, body: string): HttpResponse => {
    if (path !== '/charge') {
      // Неизвестный путь — единственный случай не-200: контракт описывает только /charge.
      return { status: 404, body: '{"ok":false,"error":{"code":"unknown_path","message":"нет такого пути"}}' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 200, body: '{"ok":false,"error":{"code":"bad_json","message":"тело не JSON"}}' };
    }

    const req = parsed as Record<string, unknown>;
    const token = typeof req['card_token'] === 'string' ? req['card_token'] : '';
    const card = CARDS[token] ?? { ok: false as const, code: 'unknown_card', message: 'карта неизвестна' };

    if (card.ok) {
      const id = `ch_${nextChargeNum++}`;
      return { status: 200, body: JSON.stringify({ ok: true, charge_id: id }) };
    }
    return { status: 200, body: JSON.stringify({ ok: false, error: { code: card.code, message: card.message } }) };
  };
}
