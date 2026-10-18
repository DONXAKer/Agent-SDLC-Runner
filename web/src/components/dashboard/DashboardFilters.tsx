import { DASHBOARD_BENCH_ARCHIVE, DASHBOARD_SOURCES } from '@sdlc-runner/shared';
import type { DashboardSource } from '@sdlc-runner/shared';

import { SOURCE_LABEL } from '../../lib/dashboardStatus.ts';
import { EMPTY_FILTER, STATUS_FILTERS, STATUS_FILTER_LABEL, isFilterEmpty } from '../../lib/dashboardFilter.ts';
import type { DashboardFilter, StatusFilter } from '../../lib/dashboardFilter.ts';

const FIELD = 'rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200';

export function DashboardFilters({
  filter,
  projects,
  shown,
  total,
  onChange,
}: {
  filter: DashboardFilter;
  projects: string[];
  shown: number;
  total: number;
  onChange: (f: DashboardFilter) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
        placeholder="поиск: slug, задача, модель"
        className={`${FIELD} w-60`}
      />
      <select
        value={filter.project ?? ''}
        onChange={(e) => onChange({ ...filter, project: e.target.value === '' ? null : e.target.value })}
        className={FIELD}
      >
        <option value="">все проекты (без архива)</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p === DASHBOARD_BENCH_ARCHIVE ? 'архив стенда' : p}
          </option>
        ))}
      </select>
      <select
        value={filter.source ?? ''}
        onChange={(e) =>
          onChange({ ...filter, source: DASHBOARD_SOURCES.find((s) => s === e.target.value) ?? null })
        }
        className={FIELD}
      >
        <option value="">все источники</option>
        {DASHBOARD_SOURCES.map((s: DashboardSource) => (
          <option key={s} value={s}>
            {SOURCE_LABEL[s]}
          </option>
        ))}
      </select>
      <select
        value={filter.status ?? ''}
        onChange={(e) => onChange({ ...filter, status: STATUS_FILTERS.find((s) => s === e.target.value) ?? null })}
        className={FIELD}
      >
        <option value="">любой статус</option>
        {STATUS_FILTERS.map((s: StatusFilter) => (
          <option key={s} value={s}>
            {STATUS_FILTER_LABEL[s]}
          </option>
        ))}
      </select>
      <span className="text-xs text-neutral-500">
        показано {shown} из {total}
      </span>
      {!isFilterEmpty(filter) ? (
        <button type="button" onClick={() => onChange(EMPTY_FILTER)} className="text-xs text-neutral-400 hover:text-neutral-200">
          сбросить
        </button>
      ) : null}
    </div>
  );
}
