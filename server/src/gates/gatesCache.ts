/**
 * Разобранный набор гейтов проекта с кэшем по времени правки — для читателей без `Run`.
 *
 * Тот же приём, что `Run.gatesFile`: набор — файл проекта, меняется раз в месяцы, а
 * читают его на каждый опрос (дашборд считает блокеры семи этапов каждого витка). Без
 * кэша опрос раз в пять секунд разбирал бы все таблицы набора синхронно, в том же цикле
 * событий, что и поток WebSocket.
 */

import { statSync } from 'node:fs';

import { readArtifact } from '../artifacts/artifact.ts';
import { parseGates } from './gatesFile.ts';
import type { GatesFile } from './gatesFile.ts';

const cache = new Map<string, { mtimeMs: number; size: number; parsed: GatesFile }>();

/** Набор гейтов по пути; `null` — файла нет. */
export function readGatesCached(path: string): GatesFile | null {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // Перенос в конец Map на попадании — иначе предел ниже вытесняет по FIFO, а не LRU,
    // и горячий набор проекта может уйти раньше холодного.
    cache.delete(path);
    cache.set(path, hit);
    return hit.parsed;
  }
  const a = readArtifact(path);
  if (!a.exists) {
    cache.delete(path);
    return null;
  }
  const parsed = parseGates(a.text);
  cache.delete(path);
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  // Предел: наборы удалённых рабочих копий стенда больше никто не спросит.
  while (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return parsed;
}
