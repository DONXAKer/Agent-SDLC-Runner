import { useState } from 'react';

import type { RunDiff } from '@sdlc-runner/shared';

import { api } from '../lib/api.ts';

/**
 * Сводный просмотр патча попытки.
 *
 * `DiffView` показывает предпросмотр ОДНОГО вызова при одобрении; здесь — всё, что попытка
 * изменила, с разметкой «в плане / вне плана». Файл вне плана подсвечен: запись туда либо
 * не проходит политику, либо вменяется исполнителю scope-гейтом, и увидеть это лучше до
 * этапа 6, а не из его красного вердикта.
 *
 * Патч грузится по кнопке, а не вместе с состоянием витка: он бывает в сотни килобайт, а
 * состояние перезапрашивается на каждый записанный артефакт.
 */
export function RunDiffView({ runId }: { runId: string }): JSX.Element {
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (): void => {
    setLoading(true);
    setError(null);
    api
      .diff(runId)
      .then(setDiff)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const outside = diff?.files.filter((f) => !f.inPlan) ?? [];

  return (
    <div className="mt-3 rounded border border-neutral-800">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="font-medium">Патч попытки</span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800 disabled:opacity-40"
        >
          {loading ? 'загрузка…' : diff === null ? 'показать' : 'обновить'}
        </button>
        {diff !== null ? (
          <span className="text-neutral-500">
            chunk {diff.chunk} · попытка {diff.attempt} · файлов {diff.files.length}
          </span>
        ) : null}
      </div>

      {error !== null ? (
        <div className="px-3 py-2 text-xs text-red-300">{error}</div>
      ) : null}

      {diff !== null ? (
        <>
          <div className="border-b border-neutral-900 px-3 py-2 text-xs">
            {outside.length > 0 ? (
              <div className="mb-1 text-amber-400">
                вне плана: {outside.length} — запись туда отклоняется политикой, а правка,
                сделанная не агентом, вменяется исполнителю scope-гейтом
              </div>
            ) : null}
            <ul className="space-y-0.5 font-mono text-[11px]">
              {diff.files.map((f) => (
                <li key={f.path} className={f.inPlan ? 'text-neutral-400' : 'text-amber-300'}>
                  {f.inPlan ? '·' : '!'} {f.path}
                </li>
              ))}
            </ul>
          </div>

          <pre className="max-h-[50vh] overflow-auto px-3 py-2 font-mono text-[11px] leading-4">
            {diff.patch.split('\n').map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'text-emerald-400'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'text-red-400'
                      : line.startsWith('@@')
                        ? 'text-sky-400'
                        : 'text-neutral-500'
                }
              >
                {line === '' ? ' ' : line}
              </div>
            ))}
          </pre>
        </>
      ) : null}
    </div>
  );
}
