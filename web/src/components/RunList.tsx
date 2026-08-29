import { useState } from 'react';

import type { RunSummary } from '@sdlc-runner/shared';

import { fmtCost } from '../lib/format.ts';
import { statusLabel, statusTone } from '../lib/runStatus.ts';

/**
 * Витки, открытые в этом процессе сервера.
 *
 * Список намеренно не называется «историей»: сервер перечисляет прогоны из памяти, и
 * после его перезапуска он пуст, хотя артефакты витка на диске целы. Обещать здесь
 * историю значило бы обещать то, чего ручка не отдаёт.
 *
 * Подписи говорят про ЭТАП, а не про виток: `RunStatus` рантайм выставляет в конце
 * каждого этапа. Слово «завершён» здесь недопустимо — рядом стоит необратимое «Убрать»,
 * и виток, прошедший всего лишь `intent`, читался бы как законченный.
 */

export function RunList({
  runs,
  onOpen,
  onForget,
  onRefresh,
}: {
  /** Непустой по построению: решение «показывать ли список» принимает вызывающий. */
  runs: RunSummary[];
  onOpen: (runId: string) => void;
  onForget: (runId: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  // Какой виток ждёт подтверждения на «Убрать». Шаг существует потому, что удаление
  // необратимо: вместе с объектом прогона уходят итоги гейтов, вердикт и признак
  // состоявшегося ревью, а восстановить их можно только заново прогнав этап.
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  return (
    <div>
      {/* Список — снимок на момент запроса: статус здесь стареет молча, поэтому
          обновление доступно руками, а не только уходом со страницы и обратно. */}
      <span className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
        <span>Открытые витки</span>
        <button
          type="button"
          onClick={onRefresh}
          className="normal-case text-neutral-400 hover:text-neutral-200"
        >
          обновить
        </button>
      </span>

      <div className="space-y-2">
        {runs.map((r) => (
          <div
            key={r.runId}
            className="flex items-center gap-3 rounded border border-neutral-800 p-3 text-sm"
          >
            <button
              type="button"
              onClick={() => onOpen(r.runId)}
              className="min-w-0 flex-1 text-left hover:text-emerald-300"
            >
              <div className="truncate font-medium">
                {r.project} · <span className="font-mono">{r.slug}</span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {/* `stage` — этап, выполняющийся ПРЯМО СЕЙЧАС, а между этапами он пуст.
                    Поэтому подпись говорит про занятость, а не про прогресс витка: «этап не
                    начат» на пустом `stage` соврало бы про виток, дошедший до verify. */}
                {r.stage === null ? 'сейчас ничего не выполняется' : `выполняется ${r.stage}`} ·
                chunk {r.chunk} · попытка {r.attempt} · профиль {r.profile} · {fmtCost(r.usage, r.currency)}
              </div>
            </button>

            <span
              className={`shrink-0 rounded border px-2 py-0.5 text-xs ${statusTone(r.status, r.stage)}`}
            >
              {statusLabel(r.status, r.stage)}
            </span>

            {confirmForget === r.runId ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                <span className="text-amber-300">Убрать?</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmForget(null);
                    onForget(r.runId);
                  }}
                  className="rounded border border-red-800 px-2 py-1 text-red-300 hover:bg-red-950"
                >
                  Да
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmForget(null)}
                  className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800"
                >
                  Нет
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmForget(r.runId)}
                title="Убрать из памяти сервера: уходят итоги гейтов, вердикт и признак состоявшегося ревью. Артефакты витка на диске остаются; пока этап выполняется, сервер откажет."
                className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              >
                Убрать
              </button>
            )}
          </div>
        ))}
      </div>

      <p className="mt-2 text-xs text-neutral-500">
        Это витки, живущие в памяти сервера, а не история на диске: после перезапуска
        сервера список пуст, хотя <code className="font-mono">.sdlc/&lt;slug&gt;/</code>{' '}
        целевого проекта никуда не делся. Статус относится к последнему этапу, а не к витку
        целиком.
      </p>
    </div>
  );
}
