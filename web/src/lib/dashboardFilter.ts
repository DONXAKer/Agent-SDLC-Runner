import { DASHBOARD_BENCH_ARCHIVE, DASHBOARD_SOURCES } from '@sdlc-runner/shared';
import type { DashboardCard, DashboardSource, HistoryStatus } from '@sdlc-runner/shared';

import { isRunningNow } from './dashboardSort.ts';

/**
 * Фильтр по статусу: статусы витка целиком плюс два живых среза — «идёт» (прогон в памяти
 * сервера) и «ждёт человека». Живые — отдельными значениями, а не статусом витка: статус
 * витка считается по артефактам, а «ждёт» — по очереди решений.
 */
export const STATUS_FILTERS = ['waiting', 'live', 'open', 'unfinished', 'done', 'aborted'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  waiting: 'ждут человека',
  live: 'идут сейчас',
  open: 'в работе',
  unfinished: 'без записи о передаче',
  done: 'переданы',
  aborted: 'оборваны',
};

export interface DashboardFilter {
  project: string | null;
  source: DashboardSource | null;
  status: StatusFilter | null;
  query: string;
}

export const EMPTY_FILTER: DashboardFilter = { project: null, source: null, status: null, query: '' };

/** Совпадение поиска: slug, текст задачи, проект, задача и модель стенда — без регистра. */
export function matchesQuery(c: DashboardCard, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  const hay = [c.ref.slug, c.ref.project, c.requirement ?? '', c.bench?.task ?? '', c.bench?.model ?? '']
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

function matchesStatus(c: DashboardCard, s: StatusFilter): boolean {
  if (s === 'waiting') return c.live !== null && c.live.waiting > 0;
  if (s === 'live') return isRunningNow(c);
  return c.status === (s satisfies HistoryStatus);
}

/** Карточка из архива стенда — на доске только когда архив выбран проектом явно. */
export function isArchived(c: DashboardCard): boolean {
  return c.ref.source === 'bench' && c.ref.project === DASHBOARD_BENCH_ARCHIVE;
}

export function applyFilter(cards: readonly DashboardCard[], f: DashboardFilter): DashboardCard[] {
  return cards.filter(
    (c) =>
      (f.project === null ? !isArchived(c) : c.ref.project === f.project) &&
      (f.source === null || c.ref.source === f.source) &&
      (f.status === null || matchesStatus(c, f.status)) &&
      matchesQuery(c, f.query),
  );
}

/** Проекты, которые есть в списке, — варианты выпадающего фильтра. */
export function projectOptions(cards: readonly DashboardCard[]): string[] {
  return [...new Set(cards.map((c) => c.ref.project))].sort((a, b) => a.localeCompare(b));
}

export function isFilterEmpty(f: DashboardFilter): boolean {
  return f.project === null && f.source === null && f.status === null && f.query.trim() === '';
}

/**
 * Фильтр из localStorage. Битое или устаревшее значение — нейтральный фильтр: чужое
 * значение источника не должно прятать все карточки без видимой причины.
 */
export function parseFilter(raw: string | null): DashboardFilter {
  if (raw === null) return EMPTY_FILTER;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof DashboardFilter, unknown>>;
    const source = DASHBOARD_SOURCES.find((s) => s === p.source) ?? null;
    const status = STATUS_FILTERS.find((s) => s === p.status) ?? null;
    return {
      project: typeof p.project === 'string' && p.project !== '' ? p.project : null,
      source,
      status,
      query: typeof p.query === 'string' ? p.query : '',
    };
  } catch {
    return EMPTY_FILTER;
  }
}

export function serializeFilter(f: DashboardFilter): string {
  return JSON.stringify(f);
}
