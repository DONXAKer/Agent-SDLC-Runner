import { useMemo, useState } from 'react';

import type { RunDiff } from '@sdlc-runner/shared';

import { api } from '../lib/api.ts';
import { orderFiles, splitPatchByFile } from '../lib/diffStats.ts';
import { diffLineTone } from '../lib/tones.ts';

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
 *
 * В компактном режиме — список файлов со счётчиками, diff файла раскрывается по клику;
 * файлы вне плана подняты наверх.
 */
export function RunDiffView({ runId, compact }: { runId: string; compact: boolean }): JSX.Element {
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Раскрытые файлы компактного списка — без localStorage: патч живёт одну попытку.
  const [openFiles, setOpenFiles] = useState<ReadonlySet<string>>(new Set());

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
  const byFile = useMemo(
    () => (diff === null ? [] : orderFiles(splitPatchByFile(diff.patch), diff.files)),
    [diff],
  );

  const toggleFile = (path: string): void => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

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

      {diff !== null && outside.length > 0 ? (
        <div className="border-b border-neutral-900 px-3 py-2 text-xs text-amber-400">
          вне плана: {outside.length} — запись туда отклоняется политикой, а правка,
          сделанная не агентом, вменяется исполнителю scope-гейтом
        </div>
      ) : null}

      {diff !== null && compact ? (
        <ul className="divide-y divide-neutral-900 font-mono text-[11px]">
          {byFile.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => toggleFile(f.path)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-neutral-900/60"
              >
                <span className={f.inPlan ? 'text-neutral-400' : 'text-amber-300'}>
                  {f.inPlan ? '·' : '!'} {f.path}
                </span>
                <span className="ml-auto shrink-0 text-emerald-400">+{f.adds}</span>
                <span className="shrink-0 text-red-400">−{f.dels}</span>
              </button>
              {openFiles.has(f.path) ? (
                <pre className="max-h-[50vh] overflow-auto border-t border-neutral-900 px-3 py-2 font-mono text-[11px] leading-4">
                  {f.text.split('\n').map((line, i) => (
                    <div key={i} className={diffLineTone(line)}>
                      {line === '' ? ' ' : line}
                    </div>
                  ))}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {diff !== null && !compact ? (
        <>
          <div className="border-b border-neutral-900 px-3 py-2 text-xs">
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
              <div key={i} className={diffLineTone(line)}>
                {line === '' ? ' ' : line}
              </div>
            ))}
          </pre>
        </>
      ) : null}
    </div>
  );
}
