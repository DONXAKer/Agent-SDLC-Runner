/**
 * Скрытые тесты задачи oversize (шаг 5 ROADMAP.md).
 *
 * Живут ВНЕ `bench/fixture/` — в рабочее дерево копии витка не попадают ни на секунду, и
 * модель их никогда не видит. Гоняются на ОДНОРАЗОВОЙ копии дерева после chunk'а, когда
 * финальный diff уже снят (иначе сам факт запуска тестов оказался бы в diff'е попытки).
 *
 * Импортируют только `src/index.ts` целевого дерева — путь к нему передаётся явно
 * (`BENCH_TARGET_DIR`), а не выводится угадыванием имени нового модуля: тест, знающий,
 * что модель назовёт файл `oversize.ts`, проверял бы телепатию, а не контракт.
 *
 * Данные (входы/эталонные значения) лежат отдельно, в `bench/expected/oversize.json` —
 * посчитаны вручную из констант фикстуры, а не списаны с вывода модели.
 *
 * Запуск: `BENCH_TARGET_DIR=<путь к дереву с src/> node --test oversize.hidden.mjs`.
 * Без переменной — цель по умолчанию `bench/fixture` (пристинная фикстура): кейсы
 * `regression` обязаны быть зелёными и там, кейсы `precision`/`human` там КРАСНЫ —
 * это не баг, а доказательство того, что скрытые тесты действительно проверяют
 * добавленную моделью логику, а не что-то, что и так было готово.
 */

import { strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, '..', '..', 'expected', 'oversize.json');
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', 'fixture');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

/** `surcharge` необязателен по форме (см. bench/fixture/task.md, п.1) — отсутствие и 0 эквивалентны. */
function surchargeOrZero(quote) {
  return typeof quote.surcharge === 'number' ? quote.surcharge : 0;
}

describe(`скрытые тесты oversize (цель: ${TARGET_DIR})`, () => {
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
      strictEqual(surchargeOrZero(q), c.expect.surchargeOrZero, 'surcharge');
      strictEqual(q.total, c.expect.total, 'total');
    });
  }
});
