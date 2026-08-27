/**
 * Обзор каталогов для выбора `projectRoot` из интерфейса.
 *
 * Сужен до одного дерева (`root` — то же самое, что смонтировано в контейнер через
 * `SDLC_BROWSE_ROOT`), причём проверка идёт по realpath, а не по строке пути: символ
 * внутри root, ведущий наружу, иначе открывал бы произвольный каталог хоста.
 *
 * Containment переиспользует `isWithinAny` из `policy/paths.ts` — тот же примитив,
 * которым уже проверяют symlink-побег в `approval/symlink.ts`, вместо второй копии той же
 * лексики со своим (более слабым, регистрозависимым) сравнением.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { BrowseResult } from '@sdlc-runner/shared';

import { isWithinAny, resolveUserPath, toPosix } from '../policy/paths.ts';
import { realpathPosix } from './realpath.ts';

function isDirectorySafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(root: string, requested: string | undefined): BrowseResult {
  const realRoot = realpathPosix(root, `SDLC_BROWSE_ROOT не найден: ${root}`);

  // Относительный `path` из запроса резолвится от `root`, а не от cwd процесса —
  // `resolveUserPath` уже даёт абсолютный нормализованный посикс-путь сама, обёртка в
  // ещё один `resolve()` не резолвит ничего лишнего, зато на Windows вернула бы
  // обратные слэши и рассинхронизировала бы формат с остальными полями ответа.
  const target = requested === undefined || requested === '' ? realRoot : resolveUserPath(realRoot, requested);
  const realTarget = realpathPosix(target, `каталог не найден: ${target}`);
  if (!isWithinAny([realRoot], realTarget)) {
    throw new Error(`каталог вне разрешённого дерева: ${target}`);
  }
  if (!statSync(realTarget).isDirectory()) throw new Error(`не каталог: ${target}`);

  const entries: BrowseResult['entries'] = [];
  for (const e of readdirSync(realTarget, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = toPosix(resolve(realTarget, e.name));

    if (e.isSymbolicLink()) {
      // Симлинк может вести куда угодно, включая мимо root, — только для него нужна
      // канонизация. Битый/недоступный симлинк, как и запись, исчезнувшая между
      // readdir и этим стейтом, молча пропускается.
      let real: string;
      try {
        real = realpathPosix(full, '');
      } catch {
        continue;
      }
      if (isWithinAny([realRoot], real) && isDirectorySafe(real)) {
        entries.push({ name: e.name, path: full });
      }
      continue;
    }

    if (e.isDirectory()) {
      // Обычная запись: readdir уже дал её реальный путь, лишний realpath/stat не нужен.
      entries.push({ name: e.name, path: full });
    } else if (!e.isFile()) {
      // `Dirent` не отдал тип: некоторые сетевые/старые ФС не поддерживают d_type,
      // и тогда единственный надёжный способ узнать, каталог ли это, — сам `statSync`.
      if (isDirectorySafe(full)) entries.push({ name: e.name, path: full });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = realTarget === realRoot ? null : dirname(realTarget);
  return { root: realRoot, path: realTarget, parent, entries };
}
