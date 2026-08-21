import { useEffect, useRef, useState } from 'react';

import { api } from '../lib/api.ts';
import { PANEL_TONE } from '../lib/tones.ts';
import type { BrowseResult } from '@sdlc-runner/shared';

interface Props {
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Обзор сужен на сервере до `SDLC_BROWSE_ROOT` — здесь просто ходим по тому, что он отдаёт. */
export function DirectoryBrowser({ onPick, onClose }: Props): JSX.Element {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Счётчик запросов вместо простого `useEffect(load, [])` на каждый клик: без него
  // более ранний ответ (клик по A), пришедший позже более позднего (клик по B), тихо
  // перезаписывает уже отображённый результат B — и путь в шапке расходится со списком.
  const requestIdRef = useRef(0);

  const load = (path?: string): void => {
    const requestId = ++requestIdRef.current;
    setError(null);
    api
      .browse(path)
      .then((r) => {
        if (requestId === requestIdRef.current) setResult(r);
      })
      .catch((e: Error) => {
        if (requestId === requestIdRef.current) setError(e.message);
      });
  };

  useEffect(() => load(), []);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Выбор каталога проекта</span>
          <button type="button" onClick={onClose} className="text-sm text-neutral-500 hover:text-neutral-300">
            ✕
          </button>
        </div>

        {error !== null ? (
          <div className={`mb-3 rounded border p-2 text-xs text-red-200 ${PANEL_TONE.fail}`}>
            {error}
          </div>
        ) : null}

        {result === null ? (
          <div className="text-sm text-neutral-500">Загрузка…</div>
        ) : (
          <>
            <div className="mb-2 truncate font-mono text-xs text-neutral-400">{result.path}</div>
            <div className="max-h-72 overflow-y-auto rounded border border-neutral-800">
              {result.parent !== null ? (
                <button
                  type="button"
                  onClick={() => load(result.parent ?? undefined)}
                  className="block w-full border-b border-neutral-800 px-3 py-2 text-left text-sm text-neutral-400 hover:bg-neutral-900"
                >
                  .. (вверх)
                </button>
              ) : null}
              {result.entries.length === 0 ? (
                <div className="px-3 py-2 text-sm text-neutral-600">пусто</div>
              ) : null}
              {result.entries.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => load(e.path)}
                  className="block w-full border-b border-neutral-800 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-900"
                >
                  {e.name}
                </button>
              ))}
            </div>

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-neutral-800 px-3 py-1.5 text-sm hover:border-neutral-600"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => onPick(result.path)}
                className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium hover:bg-emerald-600"
              >
                Выбрать этот каталог
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
