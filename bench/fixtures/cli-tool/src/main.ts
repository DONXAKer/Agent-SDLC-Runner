/**
 * Точка входа процесса: `node src/main.ts <команда> …`.
 *
 * Единственное место, которое знает про process.argv, stdout и код выхода. Всё остальное —
 * функции над массивом строк, и тестируется без процесса.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { UsageError, run } from './commands.ts';

/** Возвращает код выхода, а не зовёт process.exit: так main проверяется как функция. */
export function main(argv: readonly string[]): number {
  try {
    console.log(run(argv));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

// Исполняется только когда этот файл и есть точка входа. build-check импортирует все модули
// src подряд, и без проверки импорт main.ts запускал бы CLI с argv сборки.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
