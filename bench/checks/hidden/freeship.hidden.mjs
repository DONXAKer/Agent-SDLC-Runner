/**
 * Скрытые тесты задачи freeship (шаг 5 ROADMAP.md, вторая задача).
 *
 * Структура зеркальна `oversize.hidden.mjs` — см. комментарий там про запуск и почему
 * данные лежат в `bench/expected/freeship.json`, а не здесь. Разница: `Quote` freeship не
 * получает нового поля (`discount`/`total` существуют всегда), поэтому кейсы сверяют их
 * напрямую, без аналога `surchargeOrZero`.
 *
 * Запуск: `BENCH_TARGET_DIR=<путь к дереву с src/> node --test freeship.hidden.mjs`.
 */

import { strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, '..', '..', 'expected', 'freeship.json');
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', 'fixture');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

describe(`скрытые тесты freeship (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    const label = `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;

    it(label, () => {
      if (c.call !== undefined) {
        const fn = mod[c.call.fn];
        if (typeof fn !== 'function') {
          throw new Error(`src/index.ts не экспортирует ${c.call.fn} — контракт публичного API нарушен`);
        }
        strictEqual(fn(...c.call.args), c.expect);
        return;
      }

      if (typeof mod.quote !== 'function') {
        throw new Error('src/index.ts не экспортирует quote(order) — контракт публичного API нарушен');
      }
      const q = mod.quote(c.order);
      strictEqual(q.zone, c.expect.zone, 'zone');
      strictEqual(q.base, c.expect.base, 'base');
      strictEqual(q.discount, c.expect.discount, 'discount');
      strictEqual(q.total, c.expect.total, 'total');
    });
  }
});
