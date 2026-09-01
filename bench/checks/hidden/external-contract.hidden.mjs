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

import { strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, '..', '..', 'expected', 'external-contract.json');
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', 'fixtures', 'payments-mock');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

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
        strictEqual(seenBody, c.expect.body, 'тело запроса обязано совпасть с контрактом побайтово');
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
