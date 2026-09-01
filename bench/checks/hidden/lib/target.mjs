/**
 * Цель скрытого теста и его эталон — одно место вместо копии в каждом `<slug>.hidden.mjs`.
 *
 * Скрытые тесты живут вне фикстур и гоняются на одноразовой копии дерева после chunk'а.
 * Цель приходит через `BENCH_TARGET_DIR` (её выставляет `bench/src/hiddenTests.ts`), без
 * переменной — пристинная фикстура семейства: там regression-кейсы обязаны быть зелёными,
 * precision/human — красными, иначе они меряли бы то, что и так было готово.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(HERE, '..', '..', '..');

/** Каталог цели: `BENCH_TARGET_DIR`, иначе пристинная фикстура семейства `bench/fixtures/<family>`. */
export function targetDir(family) {
  return process.env.BENCH_TARGET_DIR ?? resolve(BENCH_DIR, 'fixtures', family);
}

/** Эталон задачи `bench/expected/<slug>.json` как объект. */
export function readExpected(slug) {
  return JSON.parse(readFileSync(resolve(BENCH_DIR, 'expected', `${slug}.json`), 'utf8'));
}

/**
 * Публичный контракт цели — только `src/index.ts`. Имя нового модуля модели не угадывается:
 * тест, знающий, что файл назовут `oversize.ts`, проверял бы телепатию, а не контракт.
 */
export async function importIndex(target) {
  return import(pathToFileURL(join(target, 'src', 'index.ts')).href);
}

/** Подпись кейса в формате, который разбирает `bench/src/hiddenTests.ts`: `Pr2 [precision] (claim-3): текст`. */
export function caseLabel(c) {
  return `${c.id} [${c.category}]${c.claim ? ` (${c.claim})` : ''}: ${c.description}`;
}

/** Экспорт цели по имени; отсутствие — нарушение публичного контракта, не «undefined is not a function». */
export function exportOf(mod, name) {
  const fn = mod[name];
  if (typeof fn !== 'function') {
    throw new Error(`src/index.ts не экспортирует ${name} — контракт публичного API нарушен`);
  }
  return fn;
}
