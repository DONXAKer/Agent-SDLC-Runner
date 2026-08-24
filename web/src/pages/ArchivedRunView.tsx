import { useEffect, useMemo, useState } from 'react';

import { EventStream } from '../components/EventStream.tsx';
import { api } from '../lib/api.ts';
import { PANEL_TONE } from '../lib/tones.ts';
import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

/**
 * Read-only просмотр АРХИВНОГО витка — того, чего нет в живой карте `runs` сервера
 * (закрыт, убран из списка, или сервер перезапускался). `RunPage` рядом целиком построен
 * вокруг живого `runId` (WS, `useRunSocket`, запуск этапов, одобрения, отмена) — заводить
 * здесь read-only-режим внутри неё means either дырявить её собственным `if (archived)` на
 * каждый интерактивный узел, либо держать отдельный, заведомо более простой компонент.
 * Выбран второй путь: у архива нет ни одного действия, только чтение ленты, которую этап
 * этого же сервера дописывал на диск по ходу витка (`eventLog.ts`).
 */
export function ArchivedRunView({
  project,
  slug,
  stageTitles,
  onExit,
}: {
  project: string;
  slug: string;
  /** Заголовки этапов из `/api/config` — тот же список, что рисует `HistoryList`/`StageRail`. */
  stageTitles: Partial<Record<StageId, string>>;
  onExit: () => void;
}): JSX.Element {
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<StageId | null>(null);

  useEffect(() => {
    setEvents(null);
    setError(null);
    setStage(null);
    api.historyEvents(project, slug).then(setEvents).catch((e: Error) => setError(e.message));
  }, [project, slug]);

  // Порядок — канонический STAGE_ORDER, отфильтрованный до этапов, реально встретившихся
  // в ленте: виток, оборвавшийся на `plan`, не должен показывать пустые вкладки `chunk`/
  // `verify`/`handoff`, до которых он не дошёл.
  const stagesPresent = useMemo(() => {
    if (events === null) return [];
    const present = new Set<StageId>();
    for (const e of events) {
      if ('stage' in e && e.stage !== null) present.add(e.stage);
    }
    return STAGE_ORDER.filter((s) => present.has(s));
  }, [events]);

  useEffect(() => {
    if (stage === null && stagesPresent.length > 0) {
      // Открывается на ПОСЛЕДНЕМ этапе с событиями — то же «куда виток реально дошёл»,
      // что и live-страница показывает по умолчанию, только без учёта блокеров (архиву
      // блокировать нечего запускать).
      setStage(stagesPresent[stagesPresent.length - 1] ?? null);
    }
  }, [stagesPresent, stage]);

  const stageEvents = useMemo(
    () => (events ?? []).filter((e) => !('stage' in e) || e.stage === stage || e.stage === null),
    [events, stage],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <button
          type="button"
          onClick={onExit}
          className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          ← к списку витков
        </button>
        <span className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-400">
          архив
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {project} · {slug}
        </span>
      </header>

      {error !== null ? (
        <div className={`m-4 whitespace-pre-wrap rounded border p-3 text-sm text-red-200 ${PANEL_TONE.fail}`}>
          {error}
        </div>
      ) : null}

      {events === null && error === null ? (
        <div className="p-8 text-sm text-neutral-400">Загрузка ленты…</div>
      ) : null}

      {events !== null && events.length === 0 ? (
        <div className="p-8 text-sm text-neutral-500">
          Для этого витка нет сохранённой ленты событий — он либо не дошёл ни до одного
          этапа, либо был начат до появления архивной записи.
        </div>
      ) : null}

      {events !== null && events.length > 0 ? (
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-800 p-3">
            <div className="mb-2 px-1 text-xs uppercase tracking-wide text-neutral-500">Этапы витка</div>
            {stagesPresent.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStage(s)}
                className={`rounded border px-2.5 py-2 text-left text-sm transition ${
                  s === stage
                    ? 'border-neutral-600 bg-neutral-800/70'
                    : 'border-transparent hover:bg-neutral-900'
                }`}
              >
                {stageTitles[s] ?? s}
              </button>
            ))}
          </nav>

          <main className="min-w-0 flex-1 overflow-auto p-4">
            <div className="max-h-[80vh] overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3">
              <EventStream events={stageEvents} />
            </div>
          </main>
        </div>
      ) : null}
    </div>
  );
}
