import type { IterationSummary } from '@sdlc-runner/shared';

/**
 * История попыток chunk↔verify.
 *
 * До неё «сколько раз мы уже пробовали и на чём именно сгорело» существовало только в
 * хронологической ленте, а лента вытесняется буфером шины и сбрасывается при
 * переподключении сокета. Здесь тот же набор фактов, что рантайм пишет в `iterations.md`:
 * второго описания истории попыток нет, поэтому таблица и файл не могут разойтись.
 */
export function AttemptsPanel({
  iterations,
  attemptBudget,
}: {
  iterations: IterationSummary[];
  attemptBudget: number;
}): JSX.Element | null {
  if (iterations.length === 0) return null;

  const last = iterations[iterations.length - 1];
  const nearBudget = last !== undefined && last.attempt >= attemptBudget;

  return (
    <div className="mt-3 rounded border border-neutral-800">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="font-medium">Попытки</span>
        <span className="text-neutral-500">всего вердиктов: {iterations.length}</span>
        {/* Близость к потолку попыток названа заранее: узнать о ней в момент, когда
            бюджет уже исчерпан, поздно — виток к этому времени встал. */}
        {nearBudget ? (
          <span className="text-amber-400">
            бюджет попыток исчерпан ({last?.attempt} из {attemptBudget})
          </span>
        ) : null}
      </div>

      <div className="divide-y divide-neutral-900">
        {iterations.map((it, i) => (
          <div key={`${it.chunk}:${it.attempt}:${i}`} className="px-3 py-2 text-xs">
            <div className="flex items-baseline gap-2">
              <span className={it.passed ? 'text-emerald-400' : 'text-red-400'}>
                {it.passed ? '✅' : '❌'}
              </span>
              <span className="font-medium text-neutral-200">
                chunk {it.chunk} · попытка {it.attempt}
              </span>
              <span className="text-neutral-500">{it.action}</span>
              {/* Совпадение с прошлым патчем — сигнал топтания, но не приговор: решение о
                  переходе принимает человек. */}
              {it.closeness !== null ? (
                <span className={it.closeness >= 0.9 ? 'text-amber-400' : 'text-neutral-500'}>
                  совпадение {Math.round(it.closeness * 100)}%
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-neutral-600">
                {it.at.slice(0, 16).replace('T', ' ')}
              </span>
            </div>

            {it.reasons.length > 0 ? (
              <ul className="mt-1 space-y-0.5 border-l border-neutral-800 pl-2 text-[11px] text-neutral-400">
                {it.reasons.map((r, j) => (
                  <li key={j} className="whitespace-pre-wrap break-words">
                    — {r}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
