import { useEffect, useRef, useState } from 'react';

/**
 * Продвижение витка: новая попытка, следующий chunk или обрыв через handoff.
 *
 * Кнопки приёмки записи сюда больше не дублируются — они живут только в `DecisionCard`
 * внутри `DecisionQueue`, на той же вкладке «Сейчас». До этого одна и та же карточка
 * `DecideButtons` рендерилась и здесь, и в очереди решений с тем же `onDecide` — оператору
 * приходилось решать, какая из двух копий актуальна.
 *
 * Sticky — вкладка «Сейчас» может быть длинной (очередь решений + промпт с двумя
 * textarea), и без прилипания к низу кнопки продвижения уходили за экран ровно в
 * момент, когда решение нужно принять быстрее всего — на красном вердикте.
 *
 * `prominent` — панель развёрнута машиной фокуса (красный вердикт: продвижение и есть
 * главное действие). В остальное время — свёрнутая строка: три всегда видимые кнопки
 * делали «Сейчас» витриной равновеликих действий, из которых актуально обычно ни одно.
 * Ручной клик переопределяет фокус до его следующей смены — как в `FocusSection`.
 */
export function AdvanceBar({
  attempt,
  attemptBudget,
  uiBusy,
  abortBlockers,
  prominent,
  onAdvance,
  onAbort,
}: {
  attempt: number;
  attemptBudget: number;
  uiBusy: boolean;
  abortBlockers: string[];
  prominent: boolean;
  onAdvance: (to: 'attempt' | 'chunk') => void;
  onAbort: () => void;
}): JSX.Element {
  const [override, setOverride] = useState<'open' | 'closed' | null>(null);
  const prevProminent = useRef(prominent);
  useEffect(() => {
    if (prominent !== prevProminent.current) {
      setOverride(null);
      prevProminent.current = prominent;
    }
  }, [prominent]);
  const open = override !== null ? override === 'open' : prominent;

  return (
    <div className="sticky bottom-0 z-10 mt-3 rounded border border-neutral-800 bg-neutral-950/95 backdrop-blur">
      <button
        type="button"
        onClick={() => setOverride(open ? 'closed' : 'open')}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="font-medium">Продвижение витка</span>
        <span className="text-neutral-500">
          попытка {attempt} из {attemptBudget}
        </span>
      </button>

      {open ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 p-3">
          <button
            type="button"
            onClick={() => onAdvance('attempt')}
            disabled={uiBusy}
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
          >
            Новая попытка ({attempt} из {attemptBudget})
          </button>
          <button
            type="button"
            onClick={() => onAdvance('chunk')}
            disabled={uiBusy}
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
          >
            Следующий chunk
          </button>
          <button
            type="button"
            onClick={onAbort}
            disabled={uiBusy || abortBlockers.length > 0}
            className="ml-auto rounded border border-amber-800 px-2 py-1 text-xs text-amber-300 hover:bg-amber-950 disabled:opacity-40"
            title={
              abortBlockers.length > 0
                ? `Обрыв невозможен: ${abortBlockers.join('; ')}`
                : 'Оформить передачу без зелёного вердикта: запись о том, почему виток брошен'
            }
          >
            Обрыв витка → handoff
          </button>
        </div>
      ) : null}
    </div>
  );
}
