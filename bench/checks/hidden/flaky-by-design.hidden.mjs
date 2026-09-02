/**
 * Скрытые тесты задачи flaky-by-design (семейство flaky-test).
 *
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test flaky-by-design.hidden.mjs`; без переменной
 * цель — пристинная фикстура. Предмет задачи — свойство НАБОРА тестов цели (перестал мигать),
 * а не число, поэтому кроме прямых вызовов эталон умеет прогон набора дочерним процессом
 * (`lib/spawnTests.mjs`, восемь раз подряд) и чтение текста теста (`lib/fileCases.mjs`).
 *
 * Пристинная: R1, R2, Pr3, H1 зелёные; Pr2 красный; Pr1 красный с ложной зеленью 0.6^8 ≈
 * 1.7 % — набор пристинной падает с p = 0.4, и восемь зелёных подряд иногда случаются.
 * Подробности — в комментариях `bench/expected/flaky-by-design.json`.
 *
 * Seeded rng реализован здесь, а не импортирован из цели: имени модуля/функции модели
 * скрытый тест знать не может, а контракт `rng: () => number` в [0, 1) зафиксирован текстом
 * задачи — по нему и подставляем.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertFileCase } from './lib/fileCases.mjs';
import { runTargetTests } from './lib/spawnTests.mjs';
import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './lib/target.mjs';

const TARGET = targetDir('flaky-test');
const expected = readExpected('flaky-by-design');
const mod = await importIndex(TARGET);

/**
 * mulberry32 — 32-битный генератор с одним словом состояния; возвращает число в [0, 1), как
 * `Math.random`. Зависимостей у bench нет, а десять строк надёжнее любой из них.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Исход как множество: порядок вытягивания — деталь реализации, состав партии — смысл. */
function outcomeKey(batch) {
  return [...batch].sort().join(',');
}

/**
 * Один прогон набора цели на этой фикстуре — секунда-две; 30 с на прогон — потолок с запасом
 * против зависшего дочернего узла, а не ожидание, что набор столько работает. Умолчание
 * помощника (120 с × 8 прогонов) на зависании держало бы кейс шестнадцать минут.
 */
const RUN_TIMEOUT_MS = 30_000;

describe(`скрытые тесты flaky-by-design (цель: ${TARGET})`, () => {
  const catalog = mod.CATALOG;
  ok(Array.isArray(catalog) && catalog.length > 0, 'src/index.ts не экспортирует непустой CATALOG — контракт публичного API нарушен');
  const pickBatch = exportOf(mod, 'pickBatch');

  for (const c of expected.cases) {
    it(caseLabel(c), async () => {
      if (c.pick !== undefined) {
        const batch = pickBatch(catalog, c.pick.n);
        ok(Array.isArray(batch), 'pickBatch обязан вернуть массив');
        if (c.expect.size !== undefined) strictEqual(batch.length, c.expect.size, 'размер партии');
        if (c.expect.unique === true) strictEqual(new Set(batch).size, batch.length, `дубли в партии ${batch.join(', ')}`);
        if (c.expect.subsetOfCatalog === true) {
          for (const sku of batch) ok(catalog.includes(sku), `позиции ${sku} нет в каталоге`);
        }
        return;
      }

      if (c.seeded !== undefined) {
        const { seed, n, repeats } = c.seeded;
        const results = [];
        for (let i = 0; i < repeats; i += 1) results.push(pickBatch(catalog, n, mulberry32(seed)));
        for (let i = 1; i < results.length; i += 1) {
          deepStrictEqual(
            results[i],
            results[0],
            `вызов ${i + 1} с тем же зерном ${seed} дал ${results[i].join(', ')} вместо ${results[0].join(', ')} — генератор не инъектируется или не используется`,
          );
        }
        strictEqual(results[0].length, n, 'размер партии при инъектированном генераторе');
        return;
      }

      if (c.suite !== undefined) {
        const r = await runTargetTests(TARGET, { times: c.suite.times, timeoutMs: RUN_TIMEOUT_MS });
        const red = r.runs.find((run) => !(run.exitCode === 0 && run.fail === 0 && run.tests > 0));
        ok(
          r.allGreen,
          `набор тестов цели зелёный ${r.greenRuns} из ${r.runs.length} прогонов — мигание не починено` +
            (red === undefined ? '' : `; красный прогон: код ${red.exitCode}, pass ${red.pass}, fail ${red.fail}\n${red.stdout.slice(0, 1500)}`),
        );
        return;
      }

      if (c.file !== undefined) {
        assertFileCase(TARGET, c);
        return;
      }

      if (c.random !== undefined) {
        const seen = new Set();
        for (let i = 0; i < c.random.calls; i += 1) seen.add(outcomeKey(pickBatch(catalog, c.random.n)));
        ok(
          seen.size > c.expect.distinctOutcomesAbove,
          `${c.random.calls} боевых вызовов без rng дали ${seen.size} различных исходов — случайность из боя выкошена`,
        );
        return;
      }

      throw new Error(`кейс ${c.id}: неизвестная форма — нет ни pick, ни seeded, ни suite, ни file, ни random`);
    });
  }
});
