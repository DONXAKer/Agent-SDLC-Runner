import type { Decision } from '@sdlc-runner/shared';

import type { PendingAsk, PendingCall } from '../../lib/pending.ts';
import { AskHumanDialog } from '../AskHumanDialog.tsx';
import { ToolApproval } from '../ToolApproval.tsx';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { DecisionCard } from './DecisionCard.tsx';

/**
 * Единая очередь всего, что ждёт человека: вопросы агента, одобрения вызовов и приёмка
 * записи. До неё карточки были рассыпаны по странице (вопросы и одобрения сверху,
 * приёмка глубоко в правой колонке), и «что от меня сейчас нужно» собиралось прокруткой.
 *
 * В компакте секция не сворачивается: прятать ожидающие решения — прятать причину, по
 * которой виток стоит.
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
  compact,
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
  compact: boolean;
}): JSX.Element | null {
  const count = asks.length + approvals.length + (decision !== null ? 1 : 0);
  if (count === 0) return null;

  return (
    <CollapsibleSection
      id="decisions"
      title="Ждут решения"
      compact={compact}
      forceOpen={compact}
      defaultOpen={true}
      summary={<span className="text-amber-300">{count}</span>}
    >
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
    </CollapsibleSection>
  );
}
