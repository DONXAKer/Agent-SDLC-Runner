/**
 * Команды утилиты.
 *
 * `run` принимает argv массивом и возвращает строку вывода: процесс, stdout и коды выхода
 * живут только в main.ts, поэтому команды проверяются обычным вызовом функции, без спавна.
 * Ошибка пользователя (нет такой команды, нет такой зоны) — `UsageError`, всё остальное
 * пробрасывается как есть: это уже дефект программы, а не ввода.
 */

import { parseArgs } from './args.ts';
import { formatTable } from './format.ts';
import { quoteLine } from './lookup.ts';
import { RATE_PER_KG, ZONES, isZone } from './tariffs.ts';

export const USAGE = [
  'qstat — справка по тарифам доставки',
  '  qstat list                таблица зон: зона, ₽/кг',
  '  qstat quote <zone> <kg>   цена отправления',
].join('\n');

/** Ошибка ввода пользователя: печатается без стека, код выхода 2. */
export class UsageError extends Error {}

export function run(argv: readonly string[]): string {
  const parsed = parseArgs(argv);

  switch (parsed.cmd) {
    case '':
      return USAGE;
    case 'list':
      return listCommand(parsed.flags.zone);
    case 'quote':
      return quoteCommand(parsed.args);
    default:
      throw new UsageError(`неизвестная команда «${parsed.cmd}»\n${USAGE}`);
  }
}

/**
 * Таблица зон: зона и ставка в рублях за килограмм. Ставки — целые рубли (см. tariffs.ts).
 *
 * С флагом `--zone <name>` печатается только строка названной зоны. Зоны, которой нет в
 * тарифах, — не ошибка, а пустой результат фильтра: опечатки в имени вводятся руками и
 * трассой об ошибки поддержке не помочь.
 */
function listCommand(zoneName?: string | true): string {
  const zone = typeof zoneName === 'string' ? zoneName : undefined;
  if (zone !== undefined) {
    if (!isZone(zone)) return 'ничего не найдено';
    return formatTable([[zone, RATE_PER_KG[zone] / 100]]);
  }
  return formatTable(ZONES.map((z) => [z, RATE_PER_KG[z] / 100]));
}

function quoteCommand(args: readonly string[]): string {
  const [zone, kgRaw] = args;
  if (zone === undefined || kgRaw === undefined) {
    throw new UsageError('quote: нужны зона и вес — qstat quote <zone> <kg>');
  }
  if (!isZone(zone)) {
    throw new UsageError(`quote: неизвестная зона «${zone}», допустимы: ${ZONES.join(', ')}`);
  }
  return quoteLine(zone, Number(kgRaw));
}
