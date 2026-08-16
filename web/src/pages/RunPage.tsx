import { useCallback, useEffect, useMemo, useState } from 'react';

import { AskHumanDialog } from '../components/AskHumanDialog.tsx';
import { CostBar } from '../components/CostBar.tsx';
import { EventStream } from '../components/EventStream.tsx';
import { PromptPane } from '../components/PromptPane.tsx';
import { StageRail } from '../components/StageRail.tsx';
import { ToolApproval, type PendingCall } from '../components/ToolApproval.tsx';
import { api } from '../lib/api.ts';
import type { Decision, PreparedPrompt, Question, RunDetail, StageId } from '@sdlc-runner/shared';
import { useRunSocket } from '../lib/useRunSocket.ts';

interface PendingAsk {
  requestId: string;
  questions: Question[];
}

export function RunPage({ runId, onExit }: { runId: string; onExit: () => void }): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [stage, setStage] = useState<StageId>('intent');
  const [prompt, setPrompt] = useState<PreparedPrompt | null>(null);
  const [requirement, setRequirement] = useState('');
  /** Что именно решил человек — сохраняется в артефакте рядом с подписью. */
  const [decisionNote, setDecisionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { events, connected } = useRunSocket(runId);

  const refresh = useCallback(() => {
    api
      .run(runId)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [runId]);

  useEffect(refresh, [refresh]);

  // Блокеры этапов считаются по файлам на диске — после каждого артефакта они меняются.
  useEffect(() => {
    const last = events[events.length - 1];
    if (last === undefined) return;
    if (last.type === 'stage_done' || last.type === 'artifact_written') refresh();
    if (last.type === 'stage_done') setBusy(false);
  }, [events, refresh]);

  /**
   * Что ещё ждёт ответа.
   *
   * Источник — ответ сервера (`detail.pendingApprovals` / `pendingQuestions`), а лента
   * событий только дополняет его свежими запросами, о которых сервер ещё не спрашивали.
   * Пока очередь выводилась ИСКЛЮЧИТЕЛЬНО из ленты, она теряла запросы: буфер шины
   * ограничен объёмом и вытесняет с начала, а при переподключении сокета лента
   * сбрасывается — карточка одобрения исчезала, промис на сервере не резолвился ничем,
   * и этап вставал навсегда, хотя `GET /api/runs/:id` этот запрос честно перечислял.
   */
  const { approvals, asks } = useMemo(() => {
    const resolved = new Set<string>();
    const answered = new Set<string>();
    for (const e of events) {
      if (e.type === 'tool_resolved') resolved.add(e.requestId);
      if (e.type === 'tool_result') answered.add(e.requestId);
    }

    const approvals = new Map<string, PendingCall>();
    const asks = new Map<string, PendingAsk>();

    for (const p of detail?.pendingApprovals ?? []) {
      approvals.set(p.requestId, {
        requestId: p.requestId,
        call: p.call,
        policy: p.policy,
        preview: p.preview,
      });
    }
    for (const q of detail?.pendingQuestions ?? []) {
      asks.set(q.requestId, { requestId: q.requestId, questions: q.questions });
    }

    for (const e of events) {
      if (e.type !== 'tool_request') continue;
      if (e.call.kind === 'ask_human') {
        if (!answered.has(e.requestId)) {
          asks.set(e.requestId, { requestId: e.requestId, questions: e.call.questions });
        }
      } else if (!resolved.has(e.requestId)) {
        approvals.set(e.requestId, {
          requestId: e.requestId,
          call: e.call,
          policy: e.policy,
          preview: e.preview,
        });
      }
    }

    for (const id of resolved) approvals.delete(id);
    for (const id of answered) asks.delete(id);

    return { approvals: [...approvals.values()], asks: [...asks.values()] };
  }, [events, detail]);

  const stageEvents = useMemo(
    () => events.filter((e) => !('stage' in e) || e.stage === stage || e.stage === null),
    [events, stage],
  );

  const stageInfo = detail?.stages.find((s) => s.id === stage) ?? null;
  const blockers = stageInfo?.blockers ?? [];

  const build = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api.preparePrompt(runId, stage, requirement === '' ? {} : { requirement });
      setPrompt(r.prompt);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (
    edited: { system: string; user: string },
    opts: { abortHandoff?: boolean } = {},
  ): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.runStage(runId, stage, { prompt: edited, ...opts });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  /** Новая попытка того же chunk'а либо следующий chunk — единственный выход из красного вердикта. */
  const advance = async (to: 'attempt' | 'chunk'): Promise<void> => {
    setError(null);
    try {
      await api.advance(runId, to);
      setPrompt(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Обрыв витка: этап 7 оформляет передачу без зелёного вердикта.
   *
   * Промпт собирается здесь же, потому что обычная кнопка запуска для handoff'а
   * заблокирована предусловием — оно и требует этого флага.
   */
  const abortWitok = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const p = await api.preparePrompt(runId, 'handoff', {});
      await api.runStage(runId, 'handoff', {
        prompt: { system: p.prompt.system, user: p.prompt.user },
        abortHandoff: true,
      });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  const resolveApproval = (requestId: string, decision: Decision): void => {
    void api.resolveApproval(runId, requestId, decision).catch((e: Error) => setError(e.message));
  };

  const decide = async (granted: boolean): Promise<void> => {
    const d = stageInfo?.decision;
    if (d == null || detail === null) return;
    setError(null);
    try {
      await api.recordDecision(runId, {
        artifact: d.artifact,
        label: d.label,
        granted,
        ...(decisionNote.trim() === '' ? {} : { note: decisionNote.trim() }),
        // Chunk и попытка — те, что человек сейчас видит: между чтением артефакта и
        // нажатием кнопки виток мог уйти на следующую попытку.
        chunk: detail.chunk,
        attempt: detail.attempt,
      });
      setDecisionNote('');
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const answer = (requestId: string, answers: Record<string, string[]>): void => {
    void api.answerQuestions(runId, requestId, answers).catch((e: Error) => setError(e.message));
  };

  if (detail === null) {
    return (
      <div className="p-8 text-sm text-neutral-400">
        {error ?? 'Загрузка витка…'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2.5">
        <button type="button" onClick={onExit} className="text-sm text-neutral-400 hover:text-neutral-200">
          ←
        </button>
        <div>
          <div className="text-sm font-medium">
            {detail.project} · <span className="font-mono">{detail.slug}</span>
          </div>
          <div className="text-xs text-neutral-500">{detail.projectRoot}</div>
        </div>

        <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs">профиль: {detail.profile}</span>
        <span className="text-xs text-neutral-500">
          chunk {detail.chunk} · попытка {detail.attempt} из {detail.attemptBudget}
        </span>

        <div className="ml-auto flex items-center gap-4">
          {/* Бюджет берётся из конфига проекта, а не из константы: до этого полоса
              сравнивала расход с чужим числом и краснела не тогда, когда надо. */}
          <CostBar usage={detail.usage} budgetUsd={detail.maxBudgetUsd} />
          <span className={connected ? 'text-xs text-emerald-500' : 'text-xs text-amber-500'}>
            {connected ? 'онлайн' : 'переподключение…'}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <StageRail run={detail} selected={stage} onSelect={setStage} />

        <main className="min-w-0 flex-1 overflow-auto p-4">
          {error !== null ? (
            <div className="mb-3 rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          {asks.map((a) => (
            <div key={a.requestId} className="mb-4">
              <AskHumanDialog requestId={a.requestId} questions={a.questions} onAnswer={answer} />
            </div>
          ))}

          {approvals.map((p) => (
            <div key={p.requestId} className="mb-4">
              <ToolApproval pending={p} onResolve={resolveApproval} />
            </div>
          ))}

          {/* minmax(0,1fr) вместо 1fr: иначе длинные пути в артефактах распирают колонку
              и правая половина уезжает за экран. */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-medium">Запрос к модели</h2>
                <button
                  type="button"
                  onClick={() => void build()}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                >
                  Собрать промпт
                </button>
                <label className="ml-auto flex items-center gap-1.5 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    onChange={(e) => void api.autoApprove(runId, stage, e.target.checked)}
                  />
                  одобрять всё на этапе
                </label>
              </div>

              {stage === 'intent' ? (
                <textarea
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  placeholder="Задача от человека — что нужно сделать в этом витке"
                  className="mb-3 h-24 w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm"
                />
              ) : null}

              <PromptPane prompt={prompt} blockers={blockers} busy={busy} onRun={(p) => void run(p)} />
            </section>

            <section className="min-w-0">
              <h2 className="mb-2 text-sm font-medium">Ход этапа</h2>
              <div className="max-h-[70vh] overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3">
                <EventStream events={stageEvents} />
              </div>

              {detail.verdict !== null && stage === 'verify' ? (
                <div
                  className={`mt-3 rounded border p-3 text-sm ${
                    detail.verdict.passed
                      ? 'border-emerald-800 bg-emerald-950/30'
                      : 'border-red-900 bg-red-950/30'
                  }`}
                >
                  <div className="mb-1 font-medium">
                    Вердикт: {detail.verdict.passed ? 'passed' : 'не пройден'} ·{' '}
                    {detail.verdict.action}
                  </div>
                  <ul className="space-y-0.5 text-xs text-neutral-300">
                    {detail.verdict.reasons.map((r, i) => (
                      <li key={i} className="whitespace-pre-wrap break-words">
                        — {r}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {stageInfo?.decision != null ? (
                <div className="mt-3 rounded border border-neutral-800 p-3">
                  <div className="mb-2 text-xs text-neutral-400">
                    Решение человека на этом этапе: <b>{stageInfo.decision.label}</b>. Пока оно не
                    записано в артефакт, следующий этап не начинается — молчание одобрением не
                    считается. Отказ методология требует записывать тем же полем.
                  </div>
                  <input
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    placeholder="Что именно решено — сохранится в артефакте рядом с подписью"
                    className="mb-2 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void decide(true)}
                      className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950"
                    >
                      Одобрить — записать в {stageInfo.decision.artifact}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(false)}
                      className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Выход из красного вердикта: новая попытка, следующий chunk или обрыв витка.
                  Без этих трёх кнопок интерфейс не имел ни одного легального продолжения. */}
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-neutral-800 p-3">
                <span className="text-xs text-neutral-400">Продвинуть виток:</span>
                <button
                  type="button"
                  onClick={() => void advance('attempt')}
                  disabled={busy}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
                >
                  Новая попытка ({detail.attempt} из {detail.attemptBudget})
                </button>
                <button
                  type="button"
                  onClick={() => void advance('chunk')}
                  disabled={busy}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
                >
                  Следующий chunk
                </button>
                <button
                  type="button"
                  onClick={() => void abortWitok()}
                  disabled={busy}
                  className="ml-auto rounded border border-amber-800 px-2 py-1 text-xs text-amber-300 hover:bg-amber-950 disabled:opacity-40"
                  title="Оформить передачу без зелёного вердикта: запись о том, почему виток брошен"
                >
                  Обрыв витка → handoff
                </button>
              </div>

              {stageInfo !== null && stageInfo.produces.length > 0 ? (
                <div className="mt-3">
                  <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
                    Артефакты этапа
                  </h3>
                  <ul className="space-y-0.5 font-mono text-xs text-neutral-400">
                    {stageInfo.produces.map((p) => (
                      <li key={p} className="break-all">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
