/**
 * Статус файла витка для дашборда: есть ли, сколько `‹…›`, размер, время правки.
 *
 * Опрос списка идёт раз в пять секунд по всем виткам всех проектов, синхронно, в том же
 * цикле событий, что и поток WebSocket, — поэтому счёт плейсхолдеров кэшируется по
 * (путь, mtime, размер): на неизменном диске повторный опрос не читает ни одного файла.
 */

import { statSync } from 'node:fs';
import { relative } from 'node:path';

import type { ArtifactPresence, DashboardArtifact } from '@sdlc-runner/shared';

import { readArtifact } from '../artifacts/artifact.ts';
import type { WitokPaths } from '../artifacts/paths.ts';

const cache = new Map<string, { mtimeMs: number; size: number; placeholders: number }>();
/**
 * Предел: запись удаляется только при повторном `stat` того же пути, а пути удалённых
 * рабочих копий стенда больше никто не спросит — без предела кэш рос бы весь срок сервера.
 */
const CACHE_MAX = 20_000;

/** Вытеснить самые старые записи Map сверх предела (порядок вставки — порядок давности). */
export function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Файлы, в которых `‹…›` не форма, а содержимое: патч и вывод тестов цитируют шаблоны,
 * JSON и лента — данные рантайма. Их плейсхолдеры не считаются (тем же правилом
 * `flow-verdict.py` не судит ответ рецензента).
 */
export function countsPlaceholders(name: string): boolean {
  return name.endsWith('.md') && !name.endsWith('-review.md');
}

export interface FileFacts {
  exists: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  placeholders: number;
}

export function fileFacts(absPath: string, name: string): FileFacts {
  let st: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    st = statSync(absPath);
  } catch {
    cache.delete(absPath);
    return { exists: false, sizeBytes: null, mtimeMs: null, placeholders: 0 };
  }
  if (!st.isFile()) return { exists: false, sizeBytes: null, mtimeMs: null, placeholders: 0 };
  if (!countsPlaceholders(name)) return { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs, placeholders: 0 };
  const hit = cache.get(absPath);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // Порядок вставки Map — порядок давности для trimOldest: без переноса записи в конец
    // на каждом попадании кэш вытеснял бы горячий путь наравне с холодным (FIFO, не LRU).
    cache.delete(absPath);
    cache.set(absPath, hit);
    return { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs, placeholders: hit.placeholders };
  }
  const placeholders = readArtifact(absPath).placeholders;
  cache.delete(absPath);
  cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, placeholders });
  trimOldest(cache, CACHE_MAX);
  return { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs, placeholders };
}

/** Имя файла относительно каталога витка (`gates.md` — для набора гейтов проекта), через `/`. */
export function relName(paths: WitokPaths, abs: string): string {
  if (abs === paths.gates) return 'gates.md';
  return relative(paths.dir, abs).split(/[\\/]/).join('/');
}

function presenceOf(f: FileFacts): ArtifactPresence {
  if (!f.exists) return 'missing';
  return f.placeholders > 0 ? 'placeholders' : 'filled';
}

export function artifactStatus(
  paths: WitokPaths,
  abs: string,
  opts: { optional?: boolean; decision?: DashboardArtifact['decision']; placeholders?: number } = {},
): DashboardArtifact {
  const name = relName(paths, abs);
  const raw = fileFacts(abs, name);
  // Переопределение счёта — у задачи: её полноту судит страж этапа 1, а не общий счётчик.
  const f = raw.exists && opts.placeholders !== undefined ? { ...raw, placeholders: opts.placeholders } : raw;
  return {
    name,
    presence: presenceOf(f),
    placeholders: f.placeholders,
    sizeBytes: f.sizeBytes,
    mtime: f.mtimeMs === null ? null : new Date(f.mtimeMs).toISOString(),
    optional: opts.optional ?? false,
    decision: opts.decision ?? null,
  };
}
