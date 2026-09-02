/**
 * Разбор аргументов командной строки.
 *
 * Свой парсер, а не библиотека: зависимостей у пакета нет, а нужны ровно две формы —
 * `--key value` и `--flag`. Первый токен без `--` — команда, остальные такие же —
 * её позиционные аргументы.
 *
 * `--key` забирает следующий токен как значение, если тот не начинается с `--`. Отсюда
 * правило для вызывающих: флаги ставятся ПОСЛЕ позиционных аргументов (`quote msk 2 --json`),
 * иначе `--json msk` прочитается как значение `msk` у ключа `json`.
 */

export interface ParsedArgs {
  /** Команда — первый позиционный токен; пустая строка, если его нет. */
  cmd: string;
  /** Позиционные аргументы после команды, в порядке появления. */
  args: string[];
  /** `--key value` → строка, `--flag` → true. */
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cmd = '';
  const args: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      if (cmd === '') cmd = token;
      else args.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === '') throw new Error('пустое имя флага: «--» без имени');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { cmd, args, flags };
}
