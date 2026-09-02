/**
 * Скрытые тесты семейства cli-tool — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` — прямой вызов функции из index.ts цели; `expect` — скаляр
 *    (strictEqual) либо объект/массив (deepStrictEqual);
 *  - `run: [argv…]` — вызов `run(argv)` команды CLI; `expect` — строка (сравнение точное,
 *    символ в символ) либо `{ rows: [[ячейка, …], …] }` — вывод режется на строки и ячейки
 *    по двум и более пробелам. Форма `rows` нужна отфильтрованной таблице: ширину колонок
 *    там законно считать и по своей строке, и по полной таблице, и исход не должен зависеть
 *    от этого выбора.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство.
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
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
const TARGET_DIR = process.env.BENCH_TARGET_DIR ?? resolve(HERE, '..', '..', '..', 'fixtures', 'cli-tool');

const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));

const indexUrl = pathToFileURL(join(TARGET_DIR, 'src', 'index.ts')).href;
const mod = await import(indexUrl);

/** Таблица → ячейки: строки по переводу строки, ячейки по двум и более пробелам. */
function tableRows(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => line.split(/ {2,}/));
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    const label = `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;

    it(label, () => {
      if (c.call !== undefined) {
        const fn = mod[c.call.fn];
        if (typeof fn !== 'function') {
          throw new Error(`src/index.ts не экспортирует ${c.call.fn} — контракт публичного API нарушен`);
        }
        const got = fn(...c.call.args);
        if (got !== null && typeof got === 'object') {
          deepStrictEqual(got, c.expect);
        } else {
          strictEqual(got, c.expect);
        }
        return;
      }

      if (typeof mod.run !== 'function') {
        throw new Error('src/index.ts не экспортирует run(argv) — контракт публичного API нарушен');
      }
      const out = mod.run(c.run);
      strictEqual(typeof out, 'string', 'run обязан вернуть строку — вывод команды');
      if (typeof c.expect === 'string') {
        strictEqual(out, c.expect);
      } else {
        deepStrictEqual(tableRows(out), c.expect.rows);
      }
    });
  }
});
