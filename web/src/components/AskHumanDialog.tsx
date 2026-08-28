import { useState } from 'react';

import type { Question } from '@sdlc-runner/shared';
import { allQuestionsAnswered } from '../lib/askAnswers.ts';
import { fmtWaitedFor } from '../lib/format.ts';

/**
 * Вопрос человеку. Отдельно от одобрения вызова: там человек разрешает уже сформированное
 * действие, здесь — сообщает недостающее знание, которое из кода не добывается.
 */
export function AskHumanDialog({
  requestId,
  questions,
  createdAt,
  serverNow,
  onAnswer,
}: {
  requestId: string;
  questions: Question[];
  /** Когда вопрос задан. Возраст показывается тем же форматом, что у одобрений, — иначе
   * «старейшее ждёт 2 ч» в шапке очереди не сопоставить с карточками глазами. */
  createdAt: number | null;
  serverNow: number;
  onAnswer: (requestId: string, answers: Record<string, string[]>) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string): void => {
    setPicked((prev) => {
      const cur = prev[q.id] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q.id]: [label] };
    });
  };

  const submit = (): void => {
    const answers: Record<string, string[]> = {};
    for (const q of questions) {
      const own = custom[q.id]?.trim();
      const chosen = picked[q.id] ?? [];
      answers[q.id] = own !== undefined && own !== '' ? [...chosen, own] : chosen;
    }
    onAnswer(requestId, answers);
  };

  // У КАЖДОГО подвопроса обязан быть ответ — выбранная опция или свой текст — прежде чем
  // «Ответить» станет нажимаемой. Раньше клик по «Ответить» без выбора (или клик по
  // соседней кнопке до того, как оператор дочитал варианты) резолвил вопрос пустым
  // `answers[q.id] = []`, и модель получала «человек ответил» на вопрос, который никто не
  // читал, — неотличимо от настоящего пропуска через отдельную кнопку.
  const allAnswered = allQuestionsAnswered(questions, picked, custom);

  return (
    <div className="rounded-lg border border-sky-700/60 bg-sky-950/20 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="font-medium text-sky-200">Агент спрашивает</h3>
        {createdAt !== null ? (
          <span className="text-xs text-sky-400/80">ждёт {fmtWaitedFor(createdAt, serverNow)}</span>
        ) : null}
      </div>

      <div className="space-y-5">
        {questions.map((q) => (
          <div key={q.id}>
            <div className="mb-1 text-xs uppercase tracking-wide text-sky-400">{q.header}</div>
            <div className="mb-2 text-sm text-neutral-200">{q.question}</div>
            <div className="space-y-1.5">
              {q.options.map((o) => {
                const on = (picked[q.id] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(q, o.label)}
                    className={`block w-full rounded border p-2 text-left text-sm transition ${
                      on
                        ? 'border-sky-500 bg-sky-900/40'
                        : 'border-neutral-800 hover:border-neutral-600'
                    }`}
                  >
                    <div className="font-medium">{o.label}</div>
                    {o.description !== '' ? (
                      <div className="text-xs text-neutral-400">{o.description}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <input
              value={custom[q.id] ?? ''}
              onChange={(e) => setCustom((p) => ({ ...p, [q.id]: e.target.value }))}
              placeholder="свой ответ"
              className="mt-2 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm"
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered}
          title={allAnswered ? undefined : 'выбери вариант или впиши свой ответ на каждый вопрос'}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500 disabled:hover:bg-neutral-800"
        >
          Ответить
        </button>
        <button
          type="button"
          onClick={() => onAnswer(requestId, {})}
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          Пропустить
        </button>
        <span className="text-xs text-neutral-500">
          Пропуск записывается как «(пропущено)», а не как согласие.
        </span>
      </div>
    </div>
  );
}
