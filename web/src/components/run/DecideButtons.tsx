/**
 * Заметка + кнопки «Одобрить/Отклонить» приёмки записи.
 *
 * Общий для карточки в очереди решений и sticky-панели действий: раньше кнопки были
 * скопированы в оба места, а поле заметки существовало только в карточке — «Одобрить» из
 * sticky-панели писало в артефакт текущий `decisionNote`, значения которого оператор не
 * видел и не мог заполнить, не прокрутив к карточке.
 */
export function DecideButtons({
  artifact,
  note,
  onNoteChange,
  onDecide,
}: {
  artifact: string;
  note: string;
  onNoteChange: (v: string) => void;
  onDecide: (granted: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <input
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Что именно решено — сохранится в артефакте рядом с подписью"
        className="min-w-[12rem] flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={() => onDecide(true)}
        className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950"
      >
        Одобрить — записать в {artifact}
      </button>
      <button
        type="button"
        onClick={() => onDecide(false)}
        className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
      >
        Отклонить
      </button>
    </div>
  );
}
