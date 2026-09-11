/**
 * Обход дерева проекта — единственный модуль индекса с файловой системой.
 *
 * Правила чтения те же, что у prefetch файлов плана (`prompt/build.ts`): содержимое
 * уходит в промпт внешнему провайдеру МИМО политики `Read`, поэтому каждый файл проверяется
 * по ФАКТИЧЕСКОМУ пути — симлинк внутри корня, указывающий наружу, не читается, и читается
 * файл по `realpath`, а не через ссылку (TOCTOU). `.sdlc` и все `.`-каталоги исключены
 * намеренно: артефакты витка — не код, и слепой вывод листа (`claimsBlind.ts`) не должен их
 * видеть.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

import { SKIP_DIRS } from '../exec/tools/index.ts';
import { CODE_EXTENSIONS } from '../gates/ecosystems/index.ts';
import { declaredSymbols } from './symbols.ts';
import { TREE_LIMITS, type ExploreIndex, type FileKind, type IndexedFile, type TreeLimits } from './types.ts';

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[^/]+$/i;
const README = /^readme(\.|$)/i;

function kindOf(rel: string): FileKind | null {
  const name = basename(rel);
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  if (README.test(name) && ext === '.md') return 'doc';
  if (!CODE_EXTENSIONS.has(ext)) return null;
  return TEST_PATH.test(rel) ? 'test' : 'code';
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Потолок глубины обхода — тот же, что у `listSourceFiles` (gates/builtin/index.ts):
 * защита от патологически глубоких деревьев, а не только от циклов ниже.
 */
const MAX_DEPTH = 12;

/** Читает дерево проекта в индекс. Корень не резолвится — индекс пустой, а не исключение. */
export function readTree(projectRoot: string, limits: TreeLimits = TREE_LIMITS): ExploreIndex {
  let realRoot: string;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    return { root: projectRoot, files: [], skipped: { files: 0, bytes: 0 } };
  }
  const files: IndexedFile[] = [];
  const skipped = { files: 0, bytes: 0 };
  let total = 0;
  // Каталог-симлинк, указывающий на предка (`a/link → a`), проходит проверку «не наружу»
  // (цель лежит ВНУТРИ корня) — без отдельного слежения за посещёнными РЕАЛЬНЫМИ путями
  // обход рекурсировал бы в `a/link/link/…` до ENAMETOOLONG: `readdirSync(a/link)`
  // перечисляет ту же запись `link` заново (ревью code-review-all, 2026-09-11,
  // воспроизведено прогоном). Ключ — РЕАЛЬНЫЙ путь каталога, не лексический: два разных
  // символических имени одного каталога обязаны схлопнуться в одно посещение.
  const visitedDirs = new Set<string>([realRoot]);

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        continue;
      }
      const back = relative(realRoot, real);
      if (back.startsWith('..') || isAbsolute(back)) continue;
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Рекурсия — по РЕАЛЬНОМУ пути, не по `abs`: обход внутри симлинка-каталога иначе
        // видел бы ту же ссылку на каждом уровне и не позволил бы `visitedDirs` её поймать.
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        walk(real, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = toPosix(relative(realRoot, real));
      const kind = kindOf(rel);
      if (kind === null) continue;
      if (files.length >= limits.maxFiles || st.size > limits.maxFileBytes || total + st.size > limits.maxTotalBytes) {
        skipped.files++;
        skipped.bytes += st.size;
        continue;
      }
      let text: string;
      try {
        text = readFileSync(real, 'utf8');
      } catch {
        continue;
      }
      total += st.size;
      files.push({
        path: rel,
        bytes: st.size,
        lines: text.split(/\r?\n/).length,
        text,
        kind,
        symbols: kind === 'doc' ? [] : declaredSymbols(text, rel),
      });
    }
  };
  walk(realRoot, 0);
  return { root: realRoot, files, skipped };
}
