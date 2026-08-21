/**
 * Панель действий оператора — прилипает к низу прокручиваемой области.
 *
 * Выход из красного вердикта: новая попытка, следующий chunk или обрыв витка. Без этих
 * трёх кнопок интерфейс не имел ни одного легального продолжения. Sticky — чтобы решение
 * не требовало прокрутки через ленту и панели: кнопки видны всегда.
 */
export function AdvanceBar({
  attempt,
  attemptBudget,
  uiBusy,
  abortBlockers,
  decision,
  onAdvance,
  onAbort,
  onDecide,
}: {
  attempt: number;
  attemptBudget: number;
  uiBusy: boolean;
  abortBlockers: string[];
  /** Ждущая приёмка записи — кнопки решения дублируются сюда, чтобы быть видимыми без прокрутки. */
  decision: { label: string; artifact: string } | null;
  onAdvance: (to: 'attempt' | 'chunk') => void;
  onAbort: () => void;
  /** Тот же хендлер, что у карточки приёмки, — логика решения не дублируется. */
  onDecide: (granted: boolean) => void;
}): JSX.Element {
  return (
    <div className="sticky bottom-0 z-10 mt-3 flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950/95 p-3 backdrop-blur">
      {decision !== null ? (
        <>
          <span className="text-xs text-amber-300">Ждёт приёмки: {decision.label}</span>
          <button
            type="button"
            onClick={() => onDecide(true)}
            className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950"
          >
            Одобрить
          </button>
          <button
            type="button"
            onClick={() => onDecide(false)}
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
          >
            Отклонить
          </button>
          <span className="mx-1 h-4 w-px bg-neutral-800" />
        </>
      ) : null}

      <span className="text-xs text-neutral-400">Продвинуть виток:</span>
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
  );
}
