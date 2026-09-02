/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи (тесты, другие пакеты), проходит через этот файл. Внутренние
 * модули друг на друга ссылаются напрямую, но потребитель знает только отсюда.
 */

export { parseArgs } from './args.ts';
export type { ParsedArgs } from './args.ts';

export { RATE_PER_KG, ZONES, isZone, priceFor } from './tariffs.ts';
export type { Kopeck, Zone } from './tariffs.ts';

export { formatQuote, formatTable } from './format.ts';
export type { Cell } from './format.ts';

export { quoteLine } from './lookup.ts';

export { USAGE, UsageError, run } from './commands.ts';
