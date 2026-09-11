/**
 * Кандидаты достройки относительного TS-специфайера без явного расширения — точное имя,
 * `.ts`, `.tsx`, `index.ts`.
 *
 * Список нужен в двух независимых местах: `exec/tools/index.ts` (терпимый резолвер
 * Write/Edit-времени — совпадение имён экспорта, а не формата пути) и
 * `gates/builtin/imports.ts`/`index.ts` (гейт «Импорты» — как раз формат пути). Раньше
 * список был продублирован дословно в обоих — правка одного места (например, добавить
 * `.mts`) молча не затронула бы второе, и две проверки разошлись бы в том, что считают
 * «резолвится».
 */

import { existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface TsSpecifierMatch {
  /** Путь, по которому файл реально найден. */
  path: string;
  /** `false` — специфайер сам по себе не резолвится, файл найден только достройкой. */
  exact: boolean;
}

/** Расширения, под которыми Node ищет ESM-модуль, но которых у TS-исходника не бывает. */
const JS_LIKE_EXT_RE = /\.(js|jsx|mjs|cjs)$/;

/**
 * Кандидаты достройки `base` в порядке проверки: сам путь, `.ts`/`.tsx`, `index.ts`/
 * `index.tsx`, и — если `base` кончается на `.js`/`.jsx`/`.mjs`/`.cjs` — те же формы с
 * СНЯТЫМ расширением (см. докстринг про замену, не догадку). Чистая функция без I/O:
 * список путей на ПРОВЕРКУ, не факт их существования — резолвер файловой системы
 * (`resolveTsSpecifier`) и резолвер по индексу разведки (`explore/rank.ts`, дерево уже в
 * памяти) обязаны пробовать одни и те же формы, а не две независимые копии списка.
 * Разделитель — `sep`: fs-путям нужен `path.join`, индексу разведки — posix-`/` (пути там
 * всегда posix, `explore/tree.ts`).
 */
export function tsSpecifierCandidates(base: string, sep: (dir: string, name: string) => string = join): string[] {
  const out = [base, `${base}.ts`, `${base}.tsx`, sep(base, 'index.ts'), sep(base, 'index.tsx')];
  const stripped = base.replace(JS_LIKE_EXT_RE, '');
  if (stripped !== base) out.push(`${stripped}.ts`, `${stripped}.tsx`);
  return out;
}

/** Та же функция для posix-путей (индекс разведки) — `sep` фиксирован на `/`. */
export function tsSpecifierCandidatesPosix(base: string): string[] {
  return tsSpecifierCandidates(base, posix.join);
}

/** `base` — специфайер уже резолвлен в абсолютный путь БЕЗ расширения (dirname + specifier). */
export function resolveTsSpecifier(base: string): TsSpecifierMatch | null {
  const [exact, ...rest] = tsSpecifierCandidates(base);
  if (existsSync(exact!) && statSync(exact!).isFile()) return { path: exact!, exact: true };
  // `./money.js`, указывающий на реально существующий `money.ts` — распространённая
  // ESM-привычка («специфайер с расширением, под которое соберётся бандлер»), а не
  // случайный мусор: ДО этой правки цикл выше пробовал ДОПИСАТЬ расширение к «.js»
  // (`money.js.ts`) вместо того, чтобы его ЗАМЕНИТЬ, специфайер тихо не резолвился, и
  // гейт «Импорты» пропускал ровно тот класс дефекта, для которого заведён — «расширение
  // не .ts» (code-review-all, 2026-09-11). Замена, а не догадка: список кандидатов уже
  // несёт снятое расширение только когда оно было js-подобным.
  for (const candidate of rest) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, exact: false };
  }
  return null;
}
