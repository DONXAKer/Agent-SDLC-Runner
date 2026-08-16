/**
 * Проверка побега через symlink.
 *
 * Живёт отдельно от политики, потому что требует диска, а политика обязана быть чистой.
 * Java-оригинал (`PathScope.java`) канонизировал ближайшего существующего предка и давал
 * отдельное сообщение; здесь то же самое, но в гейте одобрений — единственном месте
 * рантайма, которое всё равно ходит на диск ради предпросмотра.
 *
 * Без этого `vendor/cache -> C:/Users/Root/.ssh` делает запись в `vendor/cache/authorized_keys`
 * лексически внутренней: все четыре проверки политики её пропускают.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import { relativizeWithin, resolveUserPath, toPosix } from '../policy/paths.ts';

/** `null` — побега нет; строка — причина отказа. */
export function symlinkEscape(
  projectRoot: string,
  userPath: string,
  readOnlyRoots: readonly string[],
): string | null {
  const abs = resolveUserPath(projectRoot, userPath);

  // Канонизируем ближайшего существующего предка: самого файла может ещё не быть.
  let probe = abs;
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(probe)) break;
    const parent = dirname(probe);
    if (parent === probe) return null; // дошли до корня тома, канонизировать нечего
    probe = parent;
  }
  if (!existsSync(probe)) return null;

  let real: string;
  try {
    real = toPosix(realpathSync(probe));
  } catch {
    return null; // недоступен — это не наша ошибка, дальше скажет сама файловая операция
  }

  const tail = abs.slice(probe.length);
  const canonical = `${real}${tail}`;

  if (relativizeWithin(projectRoot, canonical) !== null) return null;
  if (readOnlyRoots.some((r) => relativizeWithin(r, canonical) !== null)) return null;

  return (
    `путь «${userPath}» выходит за пределы проекта через символическую ссылку: ` +
    `${probe} указывает на ${real}. Лексически путь выглядит внутренним, фактически — нет.`
  );
}
