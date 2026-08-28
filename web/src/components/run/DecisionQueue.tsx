import { useEffect, useState } from 'react';

import type { Decision } from '@sdlc-runner/shared';

import { fmtWaitedFor } from '../../lib/format.ts';
import type { PendingAsk, PendingCall } from '../../lib/pending.ts';
import { decisionQueueCount } from '../../lib/pending.ts';
import { useToggleSet } from '../../lib/useToggleSet.ts';
import { AskHumanDialog } from '../AskHumanDialog.tsx';
import { ToolApproval } from '../ToolApproval.tsx';
import { DecisionCard } from './DecisionCard.tsx';

/**
 * Единая очередь всего, что ждёт человека: вопросы агента, одобрения вызовов и приёмка
 * записи. Центр экрана витка: сама очередь и есть ответ на вопрос «что от меня нужно
 * прямо сейчас».
 */
export function DecisionQueue({
  asks,
  approvals,
  decision,
  decisionNote,
  clockOffsetMs,
  suspended,
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
  /**
   * Поправка часов: `Date.now()` клиента минус `serverNow` из ответа сервера. `createdAt`
   * проставлен часами сервера, и без поправки уход клиентских часов читался бы как
   * «ждёт 20 мин» на свежем запросе.
   */
  clockOffsetMs: number;
  /**
   * Очередь закрыта поверхностью (Drawer): карточек не видно, и шорткаты обязаны молчать —
   * «молчание одобрением не считается» держится на видимости карточек, а решение вслепую
   * его ломает с обратной стороны.
   */
  suspended: boolean;
  onNoteChange: (v: string) => void;
  onDecide: (granted: boolean) => void;
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void;
  onResolve: (requestId: string, decision: Decision) => void;
}): JSX.Element | null {
  const count = decisionQueueCount(asks, approvals, decision);
  const hasWaiting = asks.length > 0 || approvals.length > 0;

  // Возраст ожидания должен расти и в тишине, когда событий нет и ререндеров не приходит.
  // Полуминутный шаг при минутном формате: тик вдвое чаще границы, чтобы «1 мин» не
  // запаздывала на целый шаг. При пустой очереди таймер не заводится вовсе.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasWaiting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hasWaiting]);
  const serverNow = now - clockOffsetMs;

  // Карточки, в которых открыта правка аргументов: шорткат обязан молчать, пока правка
  // не закрыта, — иначе A одобрял бы вызов с ИСХОДНЫМИ аргументами, молча выбросив draft
  // (ровно класс «правка молча теряла содержимое» из pending.ts).
  const [editingIds, toggleEditing] = useToggleSet();

  /**
   * Шорткат действует ТОЛЬКО на буквально верхнюю карточку очереди — когда она
   * действительно первое одобряемое одобрение: без вопросов агента выше и не отклонена
   * политикой. Иначе подпись «одобрить верхнее» обещала бы одно, а делала другое.
   */
  const top = asks.length === 0 ? (approvals[0] ?? null) : null;
  const target = top !== null && top.policy.ok && !editingIds.has(top.requestId) ? top : null;

  useEffect(() => {
    if (target === null || suspended) return;
    const onKey = (e: KeyboardEvent): void => {
      // `e.repeat` обязателен: удержание клавиши после резолва первой карточки продолжало
      // бы слать keydown и одобрило бы следующую, ещё не прочитанную. Shift исключается
      // наравне с остальными модификаторами.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      // По `e.code`, а не `e.key`: на русской раскладке «A» — это «Ф», и буквенный
      // шорткат молча переставал бы работать. Повторный resolve уже закрытого запроса
      // (второе нажатие до обновления очереди) сервер и клиент гасят тихо — см.
      // resolveApproval в RunPage.
      if (e.code === 'KeyA') {
        onResolve(target.requestId, { allowed: true, updatedInput: null, by: 'operator' });
      } else if (e.code === 'KeyR') {
        onResolve(target.requestId, {
          allowed: false,
          reason: 'оператор отклонил вызов',
          by: 'operator',
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, suspended, onResolve]);

  if (count === 0) return null;

  // Старейшее ожидание — по известным временам; у событий старых лент времени может не быть.
  const oldest = [...asks, ...approvals]
    .map((p) => p.createdAt)
    .filter((t): t is number => t !== null)
    .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);

  return (
    <div className="rounded border border-amber-900/60 bg-amber-950/10">
      <div className="flex items-baseline gap-3 border-b border-amber-900/60 px-3 py-2 text-xs">
        <span className="font-medium">Ждут решения</span>
        <span className="text-amber-300">{count}</span>
        {oldest !== null ? (
          <span className="text-amber-400/80">старейшее ждёт {fmtWaitedFor(oldest, serverNow)}</span>
        ) : null}
        {target !== null && !suspended ? (
          <span className="ml-auto hidden text-neutral-500 sm:inline">
            A — одобрить верхнее · R — отклонить
          </span>
        ) : null}
      </div>
      <div className="space-y-4 p-3">
        {asks.map((a) => (
          <AskHumanDialog
            key={a.requestId}
            requestId={a.requestId}
            questions={a.questions}
            createdAt={a.createdAt}
            serverNow={serverNow}
            onAnswer={onAnswer}
          />
        ))}
        {approvals.map((p) => (
          <ToolApproval
            key={p.requestId}
            pending={p}
            serverNow={serverNow}
            onEditingChange={(editing) => {
              if (editing !== editingIds.has(p.requestId)) toggleEditing(p.requestId);
            }}
            onResolve={onResolve}
          />
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
