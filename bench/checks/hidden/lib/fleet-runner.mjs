/**
 * Скрытые тесты семейства fleet — общий интерпретатор эталона.
 *
 * Формат кейсов `bench/expected/<slug>.json`:
 *  - `call: { fn, args }` + `expect: число | null` — прямой вызов функции из index.ts цели,
 *    `strictEqual` (расход в мл, норма в дл/100 км, `null` для неизвестного класса);
 *  - `calls: [{ fn, args, expect }]` — несколько таких вызовов одним кейсом.
 *  Любая другая форма — ошибка ЭТАЛОНА с понятным текстом, а не `not ok`, засчитанный модели.
 *
 * Живут ВНЕ фикстуры; цель — BENCH_TARGET_DIR, умолчание — пристинное семейство
 * (`lib/target.mjs`).
 *
 * Лежит в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер. Один процесс — одна
 * обёртка: модуль кэшируется ESM, второй импорт под другим слагом не выполнится.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}
const TARGET_DIR = targetDir('fleet');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

function malformed(c, why) {
  return new Error(`эталон ${SLUG}, кейс ${c.id}: ${why} — это брак эталона, не провал модели`);
}

function checkCall(fnName, args, expect) {
  if (typeof fnName !== 'string' || !Array.isArray(args)) {
    throw new Error(`call обязан быть { fn: строка, args: массив }`);
  }
  strictEqual(exportOf(mod, fnName)(...args), expect, `${fnName}(${JSON.stringify(args)})`);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      let checked = 0;

      if (c.call !== undefined) {
        checkCall(c.call.fn, c.call.args, c.expect);
        checked += 1;
      }

      if (c.calls !== undefined) {
        for (const k of c.calls) checkCall(k.fn, k.args, k.expect);
        checked += 1;
      }

      if (checked === 0) throw malformed(c, 'нет ни call, ни calls — эталон неполный');
    });
  }
});
