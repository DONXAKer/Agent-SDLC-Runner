import type { ConfigInfo, Decision, PreparedPrompt, RunDetail, StageId } from '@sdlc-runner/shared';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const post = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const api = {
  config: (): Promise<ConfigInfo> => fetch('/api/config').then(json<ConfigInfo>),

  createRun: (project: string, slug: string, profile?: string): Promise<{ runId: string }> =>
    post('/api/runs', { project, slug, profile }).then(json<{ runId: string }>),

  run: (id: string): Promise<RunDetail> => fetch(`/api/runs/${id}`).then(json<RunDetail>),

  runs: (): Promise<{ runId: string; slug: string; project: string; status: string }[]> =>
    fetch('/api/runs').then((r) => json<{ runId: string; slug: string; project: string; status: string }[]>(r)),

  preparePrompt: (
    id: string,
    stage: StageId,
    body: { requirement?: string; extra?: string },
  ): Promise<{ prompt: PreparedPrompt; blockers: string[] }> =>
    post(`/api/runs/${id}/stages/${stage}/prompt`, body).then((r) =>
      json<{ prompt: PreparedPrompt; blockers: string[] }>(r),
    ),

  runStage: (
    id: string,
    stage: StageId,
    body: {
      prompt?: { system: string; user: string };
      requirement?: string;
      extra?: string;
      /** Объявленный оператором обрыв витка: handoff оформляется без зелёного вердикта. */
      abortHandoff?: boolean;
    },
  ): Promise<{ started: boolean }> =>
    post(`/api/runs/${id}/stages/${stage}/run`, body).then((r) => json<{ started: boolean }>(r)),

  /**
   * Продвижение витка: новая попытка того же chunk'а либо следующий chunk.
   *
   * Без этой ручки из интерфейса не было ни одного легального выхода из красного
   * вердикта: номер попытки навсегда оставался первым, а артефакты следующей писались
   * поверх — вместе с уликой для детекта отсутствия прогресса.
   */
  advance: (
    id: string,
    to: 'attempt' | 'chunk',
  ): Promise<{ chunk: number; attempt: number; attemptBudget: number }> =>
    post(`/api/runs/${id}/advance`, { to }).then((r) =>
      json<{ chunk: number; attempt: number; attemptBudget: number }>(r),
    ),

  resolveApproval: (id: string, requestId: string, decision: Decision): Promise<unknown> =>
    post(
      `/api/runs/${id}/approvals/${requestId}`,
      decision.allowed
        ? { allowed: true, updatedInput: decision.updatedInput }
        : { allowed: false, reason: decision.reason },
    ).then(json),

  answerQuestions: (
    id: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<unknown> => post(`/api/runs/${id}/questions/${requestId}`, { answers }).then(json),

  /** Записывает решение человека полем в артефакт: имя оператора и дата ставит сервер. */
  /**
   * Записывает решение человека полем в артефакт: подпись ставит сервер.
   *
   * `granted` обязателен — методология требует записывать и отказ, а единственная кнопка
   * «одобрить в один клик» отказом не является. `note` сохраняется рядом с подписью, а
   * `chunk`/`attempt` привязывают решение к тому артефакту, который человек читал, а не к
   * текущему на момент нажатия.
   */
  recordDecision: (
    id: string,
    body: {
      artifact: string;
      label: string;
      granted: boolean;
      note?: string;
      chunk?: number;
      attempt?: number;
    },
  ): Promise<{ value: string }> =>
    post(`/api/runs/${id}/decision`, body).then((r) => json<{ value: string }>(r)),

  autoApprove: (id: string, stage: StageId, on: boolean): Promise<unknown> =>
    post(`/api/runs/${id}/auto-approve`, { stage, on }).then(json),

  cancel: (id: string): Promise<unknown> => post(`/api/runs/${id}/cancel`).then(json),
};
