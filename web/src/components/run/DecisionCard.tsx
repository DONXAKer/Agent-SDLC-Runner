/** Приёмка записи: решение человека, без которого следующий этап не начинается. */
export function DecisionCard({
  decision,
  note,
  onNoteChange,
  onDecide,
}: {
  decision: { label: string; artifact: string };
  note: string;
  onNoteChange: (v: string) => void;
  onDecide: (granted: boolean) => void;
}): JSX.Element {
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className="mb-2 text-xs text-neutral-400">
        Решение человека на этом этапе: <b>{decision.label}</b>. Пока оно не записано в артефакт,
        следующий этап не начинается — молчание одобрением не считается. Отказ методология
        требует записывать тем же полем.
      </div>
      <input
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="Что именно решено — сохранится в артефакте рядом с подписью"
        className="mb-2 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecide(true)}
          className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950"
        >
          Одобрить — записать в {decision.artifact}
        </button>
        <button
          type="button"
          onClick={() => onDecide(false)}
          className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
        >
          Отклонить
        </button>
      </div>
    </div>
  );
}
