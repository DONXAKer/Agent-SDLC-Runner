/**
 * Скрытые тесты задачи external-contract.
 *
 * Живут ВНЕ фикстуры — в рабочее дерево копии витка не попадают. Цель передаётся через
 * BENCH_TARGET_DIR, умолчание — пристинная фикстура семейства: там кейсы regression
 * зелёные (мок верен сам по себе), precision — красные (функции charge пока нет).
 *
 * Импортируется только `src/index.ts` цели. Два вспомогательных вызова здесь свои:
 * `mockCharge` — прямой вызов мока (регрессия стенда), `chargeSpy` — charge() с
 * транспортом-шпионом поверх мока, записывающим точное тело запроса.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { importIndex, readExpected, targetDir } from './lib/target.mjs';

const TARGET_DIR = targetDir('payments-mock');
const expected = readExpected('external-contract');
const mod = await importIndex(TARGET_DIR);

describe(`скрытые тесты external-contract (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    const label = `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;

    it(label, () => {
      if (c.call.fn === 'mockCharge') {
        const res = mod.mockBank()('/charge', `{"card_token":"${c.call.args[0]}","amount_minor":"${c.call.args[1]}","currency":"RUB"}`);
        strictEqual(res.status, c.expect.status, 'status');
        const body = JSON.parse(res.body);
        strictEqual(body.ok, c.expect.ok, 'ok');
        if (c.expect.code !== undefined) strictEqual(body.error.code, c.expect.code, 'code');
        if (c.expect.ok === true) {
          strictEqual(typeof body.charge_id === 'string' && body.charge_id.length > 0, true, 'charge_id непустой');
        }
        return;
      }

      if (typeof mod.charge !== 'function') {
        throw new Error('src/index.ts не экспортирует charge(http, req) — функция не реализована или не реэкспортирована');
      }

      if (c.call.fn === 'chargeSpy') {
        let seenPath = null;
        let seenBody = null;
        const bank = mod.mockBank();
        const spy = (path, body) => {
          seenPath = path;
          seenBody = body;
          return bank(path, body);
        };
        mod.charge(spy, c.call.args[0]);
        strictEqual(seenPath, c.expect.path, 'path запроса');
        // Контракт фиксирует имена, типы и ПОРЯДОК полей, но не пробелы: мок сам делает
        // JSON.parse и принял бы тело с пробелами — сравнивать побайтово значило бы требовать
        // строже эталона контракта. Сравниваются разбор и порядок ключей.
        strictEqual(typeof seenBody, 'string', 'тело запроса — JSON-строка');
        const sent = JSON.parse(seenBody);
        const want = JSON.parse(c.expect.body);
        deepStrictEqual(sent, want, 'тело запроса: имена полей в змеином регистре, сумма строкой');
        deepStrictEqual(Object.keys(sent), Object.keys(want), 'порядок полей — как в примере README');
        return;
      }

      // charge: транспорт — настоящий мок, чтобы результат шёл через весь контракт.
      const result = mod.charge(mod.mockBank(), c.call.args[0]);
      strictEqual(result.status, c.expect.status, 'status');
      if (c.expect.status === 'ok') {
        strictEqual(typeof result.chargeId, 'string', 'chargeId');
        strictEqual(result.chargeId.length > 0, true, 'chargeId непустой');
      }
      if (c.expect.code !== undefined) strictEqual(result.code, c.expect.code, 'code');
    });
  }
});
