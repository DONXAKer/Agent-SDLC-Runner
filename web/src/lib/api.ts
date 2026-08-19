import type {
  AutoApproveRules,
  BrowseResult,
  ConfigInfo,
  Decision,
  PreparedPrompt,
  ProjectInfo,
  RunDetail,
  RunSummary,
  StageId,
} from '@sdlc-runner/shared';

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

  browse: (path?: string): Promise<BrowseResult> =>
    fetch(`/api/browse${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`).then(
      json<BrowseResult>,
    ),

  addProject: (name: string, projectRoot: string): Promise<ProjectInfo> =>
    post('/api/projects', { name, projectRoot }).then(json<ProjectInfo>),

  createRun: (project: string, slug: string, profile?: string): Promise<{ runId: string }> =>
    post('/api/runs', { project, slug, profile }).then(json<{ runId: string }>),

  run: (id: string): Promise<RunDetail> => fetch(`/api/runs/${id}`).then(json<RunDetail>),

  /**
   * Витки, живущие в памяти сервера. Своё описание формы здесь не держим: сервер отдаёт
   * `RunSummary` целиком, а урезанный локальный тип скрывал от интерфейса и этап, и
   * попытку, и расход — ровно то, ради чего список и нужен.
   */
  runs: (): Promise<RunSummary[]> => fetch('/api/runs').then(json<RunSummary[]>),

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

  /**
   * Правила автоодобрения на этап. Тумблер «одобрять всё» заменён ими: включавший его
   * оператор соглашался в том числе на `Bash` и на запись вне плана.
   */
  autoApprove: (id: string, stage: StageId, rules: AutoApproveRules): Promise<unknown> =>
    post(`/api/runs/${id}/auto-approve`, { stage, rules }).then(json),

  cancel: (id: string): Promise<unknown> => post(`/api/runs/${id}/cancel`).then(json),

  /**
   * Убрать виток из памяти сервера. Артефакты на диске остаются — уходит только живой
   * объект прогона. Сервер отвечает 409, пока этап выполняется, поэтому кнопка в списке
   * не может оборвать работающий виток мимо отмены.
   */
  forget: (id: string): Promise<unknown> =>
    fetch(`/api/runs/${id}`, { method: 'DELETE' }).then(json),
};
