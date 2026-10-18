import { DecideButtons } from './DecideButtons.tsx';
import type { PreparationSummary } from '@sdlc-runner/shared';

/** Приёмка записи: решение человека, без которого следующий этап не начинается. */
export function DecisionCard({
  decision,
  preparation,
  note,
  onNoteChange,
  onDecide,
}: {
  decision: { label: string; artifact: string };
  preparation?: PreparationSummary | null;
  note: string;
  onNoteChange: (v: string) => void;
  onDecide: (granted: boolean) => void;
}): JSX.Element {
  return (
    <div className="rounded border border-neutral-800 p-3">
      {decision.artifact === 'plan' && preparation != null ? (
        <div className="mb-3 space-y-2 text-xs">
          <p>Подтверждение требований и плана · редакция {preparation.revision}</p>
          {preparation.issues.map((issue, i) => <p key={i} className="whitespace-pre-wrap text-amber-300">{issue}</p>)}
          <details>
            <summary className="cursor-pointer">Актуальное понимание задачи</summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap py-2">{preparation.requirements}</pre>
          </details>
          {preparation.changes.filter((change) => preparation.revision > 1 || change.before !== '').map((change) => (
            <details key={change.section}>
              <summary className="cursor-pointer">{change.before === '' ? 'Добавлено' : change.after === '' ? 'Удалено' : 'Изменено'}: {change.section}</summary>
              <p className="mt-2 text-neutral-400">Было</p><pre className="whitespace-pre-wrap">{change.before || 'Раздел отсутствовал'}</pre>
              <p className="mt-2 text-neutral-400">Стало</p><pre className="whitespace-pre-wrap">{change.after || 'Раздел удалён'}</pre>
            </details>
          ))}
        </div>
      ) : null}
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
        approvalDisabled={decision.artifact === 'plan' && preparation != null && !preparation.readyToApprove}
      />
    </div>
  );
}
