/**
 * Проверка побега через symlink.
 *
 * Живёт отдельно от политики, потому что требует диска, а политика обязана быть чистой.
 * Java-оригинал (`PathScope.java`) канонизировал ближайшего существующего предка и давал
 * отдельное сообщение; здесь то же самое, но в гейте одобрений — единственном месте
 * рантайма, которое всё равно ходит на диск ради предпросмотра.
 *
 * Без этого `vendor/cache -> C:/Users/user/.ssh` делает запись в `vendor/cache/authorized_keys`
 * лексически внутренней: все четыре проверки политики её пропускают.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import { relativizeWithin, resolveUserPath, toPosix } from '../policy/paths.ts';

/** Канонический вид границы. Недоступна — остаётся как есть: границу не выдумываем. */
function canonicalize(dir: string): string {
  try {
    return toPosix(realpathSync(dir));
  } catch {
    return dir;
  }
}

/** `null` — побега нет; строка — причина отказа. */
export function symlinkEscape(
  projectRoot: string,
  userPath: string,
  readOnlyRoots: readonly string[],
): string | null {
  const abs = resolveUserPath(projectRoot, userPath);

  // Канонизируем ближайшего существующего предка: самого файла может ещё не быть.
  //
  // Подъём ОБЯЗАН останавливаться на корне проекта. Пока он шёл до корня тома, путь под
  // несуществующим корнем (`D:/work/proj` на POSIX, относительный `projectRoot`) уводил
  // обход в `.`, тот канонизировался в рабочий каталог серверного процесса — и КАЖДОЕ
  // чтение отвергалось как «побег через символическую ссылку». Канонизировать имеет смысл
  // только предка ВНУТРИ проекта: именно там и живёт подменённый симлинк.
  let probe = abs;
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(probe)) break;
    if (toPosix(probe) !== toPosix(projectRoot) && relativizeWithin(projectRoot, probe) === null) {
      return null; // поднялись выше корня проекта — канонизировать нечего
    }
    const parent = dirname(probe);
    if (parent === probe) return null; // дошли до корня тома
    probe = parent;
  }
  if (!existsSync(probe)) return null;

  // Найденный предок обязан лежать ВНУТРИ одной из известных границ. Иначе канонизировать
  // нечего: сравнивать канонический путь будет не с чем, и любой ответ окажется выдумкой.
  //
  // Случай не теоретический и ловится на Windows. Там `/` существует — это корень текущего
  // диска, — поэтому подъём от несуществующего корня проекта (`/proj`) останавливался на
  // `/`, канонизировал его в `D:/` и объявлял `src/a.ts` побегом через символическую ссылку.
  // Проверка границы стоит ПОСЛЕ подъёма, а не внутри него, чтобы не потерять защиту для
  // чтения из каталогов, открытых только на чтение: они лежат вне проекта законно.
  const insideKnownRoot =
    relativizeWithin(projectRoot, probe) !== null ||
    relativizeWithin(canonicalize(projectRoot), probe) !== null ||
    readOnlyRoots.some(
      (r) => relativizeWithin(r, probe) !== null || relativizeWithin(canonicalize(r), probe) !== null,
    );
  if (!insideKnownRoot) return null;

  let real: string;
  try {
    real = toPosix(realpathSync(probe));
  } catch {
    return null; // недоступен — это не наша ошибка, дальше скажет сама файловая операция
  }

  const tail = abs.slice(probe.length);
  const canonical = `${real}${tail}`;

  // Границы сравниваются в КАНОНИЧЕСКОМ виде. Сам корень проекта тоже бывает симлинком —
  // на macOS это норма (`/tmp` → `/private/tmp`, домашние каталоги через `/var`), — и без
  // канонизации границы любой путь внутри такого проекта выглядел побегом наружу.
  const canonicalRoot = canonicalize(projectRoot);
  if (relativizeWithin(projectRoot, canonical) !== null) return null;
  if (relativizeWithin(canonicalRoot, canonical) !== null) return null;
  if (readOnlyRoots.some((r) => relativizeWithin(r, canonical) !== null)) return null;
  if (readOnlyRoots.some((r) => relativizeWithin(canonicalize(r), canonical) !== null)) return null;

  return (
    `путь «${userPath}» выходит за пределы проекта через символическую ссылку: ` +
    `${probe} указывает на ${real}. Лексически путь выглядит внутренним, фактически — нет.`
  );
}
