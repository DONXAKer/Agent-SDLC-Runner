/**
 * Слоты доков.
 *
 * Слот — полуинтервал [start, end): в момент `end` док уже свободен, и слот, начавшийся
 * ровно в `end` предыдущего, с ним не пересекается. Иначе сетка «08:00–10:00, 10:00–12:00»
 * требовала бы минутного зазора между соседями, которого в расписании нет.
 */

import { instantOf } from './clock.ts';

export interface Slot {
  /** Начало слота, ISO 8601 с явным смещением. Входит в слот. */
  startIso: string;
  /** Конец слота, ISO 8601 с явным смещением. В слот НЕ входит. */
  endIso: string;
}

/** Пересекаются ли два слота хотя бы на мгновение. Касание концами пересечением не считается. */
export function overlaps(a: Slot, b: Slot): boolean {
  return instantOf(a.startIso) < instantOf(b.endIso) && instantOf(b.startIso) < instantOf(a.endIso);
}
