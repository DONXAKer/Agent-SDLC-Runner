import { DecideButtons } from './DecideButtons.tsx';

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
      <DecideButtons
        artifact={decision.artifact}
        note={note}
        onNoteChange={onNoteChange}
        onDecide={onDecide}
      />
    </div>
  );
}
