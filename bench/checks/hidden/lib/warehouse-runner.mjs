/**
 * Скрытые тесты семейства warehouse — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json` (в одном кейсе допустимо несколько проверок —
 * все перечисленные обязаны сойтись):
 *  - `call: { fn, args }` + `expect: число | null` — прямой вызов функции из index.ts цели;
 *  - `calls: [{ fn, args, expect }]` — несколько таких вызовов одним кейсом (соседние
 *    категории «не тронуты» проверяются вместе, а не тремя кейсами про одно);
 *  - `table: { name, keys?, entries? }` — экспортированная таблица-константа: `keys` — ТОЧНЫЙ
 *    набор ключей (ничего сверх факта человека не выдумано), `entries` — значения по ключам;
 *  - `noExportMatching: регулярка` — среди экспортов index.ts нет имени, похожего на
 *    выдуманную сущность (`secondLimitFor` и родня). Это сторож отрицательного факта: имя
 *    выдумки угадать нельзя, но семейство имён «вторая ступень» — можно.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство.
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const EXPECTED_PATH = resolve(HERE, '..', '..', '..', 'expected', `${SLUG}.json`);
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', '..', 'fixtures', 'warehouse');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

function callOf(fnName, args) {
  const fn = mod[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`src/index.ts не экспортирует ${fnName} — контракт публичного API нарушен`);
  }
  return fn(...args);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    const label = `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;

    it(label, () => {
      let checked = 0;

      if (c.call !== undefined) {
        strictEqual(callOf(c.call.fn, c.call.args), c.expect, `${c.call.fn}(${JSON.stringify(c.call.args)})`);
        checked += 1;
      }

      if (c.calls !== undefined) {
        for (const k of c.calls) {
          strictEqual(callOf(k.fn, k.args), k.expect, `${k.fn}(${JSON.stringify(k.args)})`);
        }
        checked += 1;
      }

      if (c.table !== undefined) {
        const table = mod[c.table.name];
        if (typeof table !== 'object' || table === null) {
          throw new Error(`src/index.ts не экспортирует таблицу ${c.table.name} — контракт публичного API нарушен`);
        }
        if (c.table.keys !== undefined) {
          deepStrictEqual(Object.keys(table).sort(), [...c.table.keys].sort(), `набор ключей ${c.table.name}`);
        }
        for (const [key, value] of Object.entries(c.table.entries ?? {})) {
          strictEqual(table[key], value, `${c.table.name}.${key}`);
        }
        checked += 1;
      }

      if (c.noExportMatching !== undefined) {
        const re = new RegExp(c.noExportMatching, 'iu');
        const suspicious = Object.keys(mod).filter((name) => re.test(name));
        ok(suspicious.length === 0, `index.ts экспортирует ${suspicious.join(', ')}: сущность, которой в регламенте нет, выдумана`);
        checked += 1;
      }

      if (checked === 0) throw new Error(`кейс ${c.id} не содержит ни одной проверки — эталон неполный`);
    });
  }
});
