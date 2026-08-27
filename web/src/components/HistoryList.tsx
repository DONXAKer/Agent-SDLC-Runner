import { useState } from 'react';

import type { HistoryEntry, StageId } from '@sdlc-runner/shared';

import { historyStatusLabel, historyStatusTone } from '../lib/historyStatus.ts';

/**
 * История витков проекта — читается сервером с диска (`GET /api/history`), а не из
 * памяти живых прогонов. Дополняет «Открытые витки»: те живут до перезапуска сервера,
 * эта переживает его — источник один и тот же `.sdlc/<slug>/`, разная только выборка.
 */
/** Сколько строк истории видно, пока её не раскрыли целиком. */
const COMPACT_ROWS = 3;

export function HistoryList({
  entries,
  stageTitles,
  compact = false,
  onOpen,
  onRefresh,
}: {
  entries: HistoryEntry[];
  /**
   * Показать только первые несколько витков с кнопкой «вся история».
   *
   * История длинная и растёт: на стартовом экране она отодвигала вниз то, ради чего на
   * него заходят, — открытые витки и новый виток.
   */
  compact?: boolean;
  /** Заголовки этапов из `/api/config` — тот же список, что рисует `StageRail`. */
  stageTitles: Partial<Record<StageId, string>>;
  /**
   * Открыть виток на странице витка. Раньше доступно было только для `status === 'open'`
   * (то, что сервер и так держит в памяти) — для `done`/`aborted`/`unfinished` открывать
   * было нечего: `GET /api/runs/:id` отдаёт `404` для всего, чего нет в живой карте.
   * `GET /api/history/:slug/events` читает архивную ленту с диска независимо от того, жив
   * ли процесс, поэтому открыть можно любой статус — страница витка сама решает, показывать
   * live-режим (WS) или read-only архив, по тому, нашёлся ли виток среди живых.
   */
  onOpen: (slug: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hidden = compact && !expanded ? Math.max(0, entries.length - COMPACT_ROWS) : 0;
  const shown = hidden > 0 ? entries.slice(0, COMPACT_ROWS) : entries;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-neutral-500">История витков</span>
        <button type="button" onClick={onRefresh} className="text-xs text-neutral-500 hover:text-neutral-300">
          обновить
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-neutral-500">
          В <code className="font-mono">.sdlc/</code> целевого проекта витков не найдено.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-900 rounded border border-neutral-800">
          {shown.map((e) => (
            <li key={e.slug} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${historyStatusTone(e.status)}`}>
                {historyStatusLabel(e.status)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{e.slug}</span>
              <span className="shrink-0 text-xs text-neutral-500">
                {e.lastStage !== null ? (stageTitles[e.lastStage] ?? e.lastStage) : 'этап не начат'}
              </span>
              <span className="shrink-0 text-xs text-neutral-600">
                {e.updatedAt.slice(0, 16).replace('T', ' ')}
              </span>
              <button
                type="button"
                onClick={() => onOpen(e.slug)}
                className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
              >
                открыть
              </button>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-neutral-500 hover:text-neutral-300"
        >
          вся история ({entries.length}) ▾
        </button>
      ) : null}
    </div>
  );
}
