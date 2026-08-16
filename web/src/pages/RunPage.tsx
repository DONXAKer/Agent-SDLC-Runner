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

  /** Что ещё ждёт ответа: запрос без парного разрешения. */
  const { approvals, asks } = useMemo(() => {
    const resolved = new Set<string>();
    const answered = new Set<string>();
    for (const e of events) {
      if (e.type === 'tool_resolved') resolved.add(e.requestId);
      if (e.type === 'tool_result') answered.add(e.requestId);
    }

    const approvals: PendingCall[] = [];
    const asks: PendingAsk[] = [];
    for (const e of events) {
      if (e.type !== 'tool_request') continue;
      if (e.call.kind === 'ask_human') {
        if (!answered.has(e.requestId)) asks.push({ requestId: e.requestId, questions: e.call.questions });
      } else if (!resolved.has(e.requestId)) {
        approvals.push({
          requestId: e.requestId,
          call: e.call,
          policy: e.policy,
          preview: e.preview,
        });
      }
    }
    return { approvals, asks };
  }, [events]);

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

  const run = async (edited: { system: string; user: string }): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.runStage(runId, stage, { prompt: edited });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  const resolveApproval = (requestId: string, decision: Decision): void => {
    void api.resolveApproval(runId, requestId, decision).catch((e: Error) => setError(e.message));
  };

  const decide = async (): Promise<void> => {
    const d = stageInfo?.decision;
    if (d == null) return;
    setError(null);
    try {
      await api.recordDecision(runId, d.artifact, d.label);
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
                    считается.
                  </div>
                  <button
                    type="button"
                    onClick={() => void decide()}
                    className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950"
                  >
                    Записать решение в {stageInfo.decision.artifact}
                  </button>
                </div>
              ) : null}

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
