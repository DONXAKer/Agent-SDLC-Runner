import { useEffect, useRef, useState } from 'react';

import type { RunSummary } from '@sdlc-runner/shared';

import { fmtCost, fmtDuration } from '../lib/format.ts';
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

/**
 * Период самообновления списка, МИЛЛИСЕКУНДЫ (как и говорит суффикс имени): раз в пять
 * секунд. Порядок величины секундный намеренно — `GET /api/runs` дёшев, но не бесплатен,
 * и витков может быть несколько.
 */
const AUTO_REFRESH_MS = 5_000;

export function RunList({
  runs,
  onOpen,
  onForget,
  onRefresh,
  onAutoRefresh,
}: {
  /** Непустой по построению: решение «показывать ли список» принимает вызывающий. */
  runs: RunSummary[];
  onOpen: (runId: string) => void;
  onForget: (runId: string) => void;
  /** Обновление ПО КНОПКЕ — действие человека: оно вправе снять свою же прошлую ошибку. */
  onRefresh: () => void;
  /**
   * Фоновый тик. Отдельно от `onRefresh` намеренно: тот гасит баннер ошибки, и, будучи
   * подключённым к таймеру, стирал причину отказа («Убрать» с кодом 409, ошибка старта,
   * отказ /api/config) через пять секунд после её появления — кнопка выглядела просто
   * сломанной (ревью).
   */
  onAutoRefresh: () => void;
}): JSX.Element {
  // Какой виток ждёт подтверждения на «Убрать». Шаг существует потому, что удаление
  // необратимо: вместе с объектом прогона уходят итоги гейтов, вердикт и признак
  // состоявшегося ревью, а восстановить их можно только заново прогнав этап.
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  // Списку больше не нужна только ручная кнопка «обновить»: он тянет состояние сам.
  // На скрытой вкладке тики пропускаются — фоновый опрос ушедшего оператора ни к чему.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) onAutoRefresh();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [onAutoRefresh]);

  // Ждущие человека — первыми: виток, крутящийся сам, и виток, стоящий на решении,
  // выглядели одинаково, хотя второй — единственный, где человек нужен прямо сейчас.
  // Сортировка стабильная: внутри одного waiting порядок сервера сохраняется.
  // Порядок замораживается, пока открыто подтверждение «Убрать»: фоновый тик менял
  // `waiting` и переставлял строки под курсором ровно перед необратимым действием.
  const frozen = useRef<RunSummary[] | null>(null);
  if (confirmForget === null) frozen.current = null;
  const sorted = frozen.current ?? [...runs].sort((a, b) => b.waiting - a.waiting);
  if (confirmForget !== null && frozen.current === null) frozen.current = sorted;

  return (
    <div>
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
        {sorted.map((r) => (
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
                {r.waiting > 0 ? (
                  // Счёт — серверный, тот же, что очередь решений внутри витка: бейдж
                  // обязан совпадать с тем, что оператор увидит, открыв прогон.
                  <span
                    className="ml-2 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs text-amber-200"
                    title="одобрения, вопросы и красный вердикт, ждущие решения"
                  >
                    ждёт: {r.waiting}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {/* `stage` — этап, выполняющийся ПРЯМО СЕЙЧАС, а между этапами он пуст.
                    Поэтому подпись говорит про занятость, а не про прогресс витка: «этап не
                    начат» на пустом `stage` соврало бы про виток, дошедший до verify. */}
                {r.stage === null
                  ? 'сейчас ничего не выполняется'
                  : // Кламп по нулю: поправки часов клиент↔сервер у `RunSummary` нет, и на
                    // машине с отстающими часами разность печаталась как «-120000 мс».
                    `выполняется ${r.stage} · ${fmtDuration(Math.max(0, Date.now() - (r.stageStartedAt ?? Date.now())))}`}{' '}
                · chunk {r.chunk} · попытка {r.attempt} из {r.attemptBudget} · профиль{' '}
                {r.profile} · {fmtCost(r.usage, r.currency)}
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
        целевого проекта никуда не делся. Список обновляется сам раз в несколько секунд,
        пока вкладка видна; статус относится к последнему этапу, а не к витку целиком.
      </p>
    </div>
  );
}
