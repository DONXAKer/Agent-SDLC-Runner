/**
 * `realpathSync` + `toPosix` в одном вызове.
 *
 * `policy/paths.ts` обязан оставаться чистым (без I/O — его гоняет conformance-тест),
 * поэтому канонизация живёт здесь, а не там; но сам паттерн «канонизировать и привести
 * к posix» нужен во всех местах, что потом сравнивают путь через `relativizeWithin` —
 * дублировать `toPosix(realpathSync(...))` в каждом из них незачем.
 */

import { existsSync, realpathSync } from 'node:fs';

import { toPosix } from '../policy/paths.ts';

/** Кидает по-русски, если пути не существует — вместо сырого `ENOENT` от Node. */
export function realpathPosix(p: string, notFoundMessage: string): string {
  if (!existsSync(p)) throw new Error(notFoundMessage);
  return toPosix(realpathSync(p));
}
