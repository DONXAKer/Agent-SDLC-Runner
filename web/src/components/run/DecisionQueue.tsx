import type { Decision } from '@sdlc-runner/shared';

import type { PendingAsk, PendingCall } from '../../lib/pending.ts';
import { decisionQueueCount } from '../../lib/pending.ts';
import { AskHumanDialog } from '../AskHumanDialog.tsx';
import { ToolApproval } from '../ToolApproval.tsx';
import { DecisionCard } from './DecisionCard.tsx';

/**
 * Единая очередь всего, что ждёт человека: вопросы агента, одобрения вызовов и приёмка
 * записи. Живёт на вкладке «Сейчас» — отдельной от наблюдательной вкладки «Ход», поэтому
 * прятать её сворачиванием больше не нужно: сама вкладка и есть ответ на вопрос «что от
 * меня нужно прямо сейчас».
 */
export function DecisionQueue({
  asks,
  approvals,
  decision,
  decisionNote,
  onNoteChange,
  onDecide,
  onAnswer,
  onResolve,
}: {
  asks: PendingAsk[];
  approvals: PendingCall[];
  /** Ждущая приёмка записи этапа — или null, когда этап её не требует либо она записана. */
  decision: { label: string; artifact: string } | null;
  decisionNote: string;
  onNoteChange: (v: string) => void;
  onDecide: (granted: boolean) => void;
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void;
  onResolve: (requestId: string, decision: Decision) => void;
}): JSX.Element | null {
  const count = decisionQueueCount(asks, approvals, decision);
  if (count === 0) return null;

  return (
    <div className="rounded border border-amber-900/60 bg-amber-950/10">
      <div className="border-b border-amber-900/60 px-3 py-2 text-xs">
        <span className="font-medium">Ждут решения</span>{' '}
        <span className="text-amber-300">{count}</span>
      </div>
      <div className="space-y-4 p-3">
        {asks.map((a) => (
          <AskHumanDialog key={a.requestId} requestId={a.requestId} questions={a.questions} onAnswer={onAnswer} />
        ))}
        {approvals.map((p) => (
          <ToolApproval key={p.requestId} pending={p} onResolve={onResolve} />
        ))}
        {decision !== null ? (
          <DecisionCard
            decision={decision}
            note={decisionNote}
            onNoteChange={onNoteChange}
            onDecide={onDecide}
          />
        ) : null}
      </div>
    </div>
  );
}
