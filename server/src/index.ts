/**
 * HTTP + WebSocket сервер Agent-SDLC Runner.
 *
 * Один оператор, локальная машина, без аутентификации — сервис поднимается рядом с
 * проектом, а не в сети. Всё состояние витка на диске, здесь только живые прогоны.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';

import type {
  ConfigInfo,
  Decision,
  PromptResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  StageId,
} from '@sdlc-runner/shared';

import { AskGate } from './approval/askGate.ts';
import { ApprovalGate } from './approval/gate.ts';
import { EventBus } from './bus.ts';
import { loadConfig, requireProject } from './config/load.ts';
import { ProfileError, resolveStartableProfile } from './config/profiles.ts';
import { Run } from './run/Run.ts';
import { STAGES, isStageId, stageById } from './run/stages.ts';

const config = loadConfig();
const bus = new EventBus();

const gate = new ApprovalGate({
  onPending: (p) =>
    bus.emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      call: p.call,
      policy: p.policy,
      preview: p.preview,
      writeTargets: p.writeTargets,
    }),
  onResolved: (info, decision) =>
    bus.emit({
      type: 'tool_resolved',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      decision,
    }),
});

const askGate = new AskGate({
  onPending: (p) =>
    bus.emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      call: { kind: 'ask_human', questions: p.questions },
      policy: { ok: true },
      preview: null,
      writeTargets: null,
    }),
  onAnswered: (info, answers) =>
    bus.emit({
      type: 'tool_result',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      ok: true,
      summary: `ответы получены: ${Object.keys(answers).length}`,
      durationMs: 0,
    }),
});

interface LiveRun {
  run: Run;
  currentStage: StageId | null;
}

const runs = new Map<string, LiveRun>();

const app = Fastify({ logger: { level: 'warn' } });
await app.register(websocket);

// ── валидация входа ────────────────────────────────────────────────────────

/**
 * Slug становится именем каталога артефактов, поэтому он не может содержать
 * разделителей: `../../../Users/Root/.ssh` заставлял рантайм читать файлы вне проекта
 * и вклеивать их содержимое в промпт. Политика тут не помогает — читает сам рантайм.
 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function badSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) {
    return 'slug может содержать только латиницу, цифры, точку, дефис и подчёркивание (до 64 символов)';
  }
  if (slug === '.' || slug === '..' || slug.includes('..')) return 'slug не может содержать «..»';
  return null;
}

function liveRun(id: string): LiveRun | null {
  return runs.get(id) ?? null;
}

// ── справочники ────────────────────────────────────────────────────────────

app.get('/api/config', (): ConfigInfo => ({
  operator: config.runner.operator,
  projects: [...config.projects.values()].map((p) => ({
    name: p.name,
    projectRoot: p.projectRoot,
    activeProfile: p.activeProfile,
    maxBudgetUsd: p.maxBudgetUsd,
    profiles: Object.entries(p.profiles).map(([name, def]) => ({
      name,
      label: def.label,
      stages: def.stages,
    })),
  })),
  models: config.models.models,
  stages: STAGES.map((s) => ({ id: s.id, title: s.title, tools: s.tools })),
}));

// ── прогоны ────────────────────────────────────────────────────────────────

app.post('/api/runs', async (req, reply) => {
  const body = req.body as { project?: string; slug?: string; profile?: string };
  if (typeof body.project !== 'string' || typeof body.slug !== 'string') {
    return reply.code(400).send({ error: 'нужны поля project и slug' });
  }

  const slugProblem = badSlug(body.slug);
  if (slugProblem !== null) return reply.code(400).send({ error: slugProblem });

  try {
    const project = requireProject(config, body.project);
    const profileName = body.profile ?? project.activeProfile;
    // Правило рецензента проверяется здесь: виток с ревью слабее исполнителя не стартует.
    const profile = resolveStartableProfile(project, config.models, profileName);

    const run = new Run({
      config,
      project,
      profile,
      slug: body.slug,
      gate,
      askGate,
      emit: (e: RunEvent) => bus.emit(e),
    });

    runs.set(run.id, { run, currentStage: null });
    bus.emit({
      type: 'run_started',
      runId: run.id,
      slug: run.slug,
      profile: profile.name,
      projectRoot: project.projectRoot,
    });

    return { runId: run.id, profile: profile.name, routes: profile.routes };
  } catch (e) {
    const problems = e instanceof ProfileError ? e.problems : [(e as Error).message];
    return reply.code(400).send({ error: problems.join('\n'), problems });
  }
});

app.get('/api/runs', (): RunSummary[] =>
  [...runs.values()].map(({ run, currentStage }) => ({
    runId: run.id,
    slug: run.slug,
    project: run.project.name,
    profile: run.profile.name,
    status: run.status,
    stage: currentStage,
    chunk: run.chunk,
    attempt: run.attempt,
    usage: run.totalUsage,
  })),
);

app.get('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const { run, currentStage } = live;
  const detail: RunDetail = {
    runId: run.id,
    slug: run.slug,
    project: run.project.name,
    projectRoot: run.project.projectRoot,
    profile: run.profile.name,
    routes: run.profile.routes,
    status: run.status,
    stage: currentStage,
    chunk: run.chunk,
    attempt: run.attempt,
    attemptBudget: run.attemptBudget,
    maxBudgetUsd: run.project.maxBudgetUsd,
    usage: run.totalUsage,
    stages: STAGES.map((s) => ({
      id: s.id,
      title: s.title,
      tools: s.tools,
      blockers: run.blockers(s.id),
      produces: s.produces(run.ctx),
      decision: s.humanGate,
    })),
    pendingApprovals: gate.list().filter((p) => p.runId === id),
    pendingQuestions: askGate.list().filter((p) => p.runId === id),
    gateResults: run.gateResults,
    verdict: run.lastVerdict,
    // История событий здесь не отдаётся: клиент получает её по WebSocket при
    // подключении, а дублирование гоняло по проводу полные тексты файлов впустую.
  };
  return detail;
});

/**
 * Запись решения человека полем в артефакт.
 *
 * Отдельная ручка, потому что это и есть гейт: методология считает решение состоявшимся
 * только тогда, когда оно записано в файл с именем и датой. Одобрение, оставшееся в
 * интерфейсе, для следующего этапа не существует.
 */
app.post('/api/runs/:id/decision', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const body = req.body as { artifact?: string; label?: string };
  if (typeof body.artifact !== 'string' || typeof body.label !== 'string') {
    return reply.code(400).send({ error: 'нужны поля artifact и label' });
  }

  try {
    const value = live.run.recordDecision(body.artifact, body.label);
    return { ok: true, value };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

/** Промпт готовится отдельным шагом: оператор вправе увидеть и поправить его до отправки. */
app.post('/api/runs/:id/stages/:stage/prompt', async (req, reply) => {
  const { id, stage } = req.params as { id: string; stage: string };
  if (!isStageId(stage)) return reply.code(400).send({ error: `неизвестный этап: ${stage}` });

  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const body = (req.body ?? {}) as { requirement?: string; extra?: string };
  try {
    const response: PromptResponse = {
      prompt: live.run.preparePrompt(stage, body),
      blockers: live.run.blockers(stage),
    };
    return response;
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.post('/api/runs/:id/stages/:stage/run', async (req, reply) => {
  const { id, stage } = req.params as { id: string; stage: string };
  if (!isStageId(stage)) return reply.code(400).send({ error: `неизвестный этап: ${stage}` });

  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });
  if (live.currentStage !== null) {
    return reply.code(409).send({ error: `этап ${live.currentStage} уже выполняется` });
  }

  const body = (req.body ?? {}) as {
    prompt?: { system?: unknown; user?: unknown };
    requirement?: string;
    extra?: string;
    abortHandoff?: boolean;
  };

  let editedPrompt: { system: string; user: string } | null = null;
  if (body.prompt !== undefined) {
    if (typeof body.prompt.system !== 'string' || typeof body.prompt.user !== 'string') {
      return reply.code(400).send({ error: 'prompt.system и prompt.user должны быть строками' });
    }
    editedPrompt = { system: body.prompt.system, user: body.prompt.user };
  }

  // Схемы инструментов и пометка о скрытом пресете берутся из свежей сборки: оператор
  // правит текст, а не состав инструментов, и presetNote обязан остаться правдой.
  const base = live.run.preparePrompt(stage, body);

  live.currentStage = stage;

  // Этап живёт дольше HTTP-запроса: клиент следит за ним по WebSocket. Без catch любая
  // ошибка вне try внутри runStage становилась unhandled rejection и роняла процесс
  // вместе со всеми живыми витками.
  void live.run
    .runStage(stage, {
      ...(body.requirement === undefined ? {} : { requirement: body.requirement }),
      ...(body.extra === undefined ? {} : { extra: body.extra }),
      ...(body.abortHandoff === true ? { abortHandoff: true } : {}),
      ...(editedPrompt === null
        ? {}
        : {
            prompt: {
              ...base,
              system: editedPrompt.system,
              user: editedPrompt.user,
              editedByOperator:
                editedPrompt.system !== base.system || editedPrompt.user !== base.user,
            },
          }),
    })
    .catch((e: unknown) => {
      bus.emit({
        type: 'error',
        runId: id,
        stage,
        message: `этап не запустился: ${(e as Error).message}`,
      });
    })
    .finally(() => {
      live.currentStage = null;
      // Автоодобрение действует на один этап: оставленное включённым, оно молча
      // распространялось бы на все последующие попытки.
      gate.clearAutoApprove(id, stage);
    });

  return reply.code(202).send({ started: true, stage });
});

/** Продвижение витка: новая попытка того же chunk'а либо следующий chunk. */
app.post('/api/runs/:id/advance', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });
  if (live.currentStage !== null) {
    return reply.code(409).send({ error: `этап ${live.currentStage} выполняется` });
  }

  const body = req.body as { to?: 'attempt' | 'chunk' };
  if (body.to === 'attempt') {
    const attempt = live.run.nextAttempt();
    return { chunk: live.run.chunk, attempt, attemptBudget: live.run.attemptBudget };
  }
  if (body.to === 'chunk') {
    const chunk = live.run.nextChunk();
    return { chunk, attempt: live.run.attempt, attemptBudget: live.run.attemptBudget };
  }
  return reply.code(400).send({ error: 'поле to должно быть «attempt» или «chunk»' });
});

// ── одобрения и вопросы ────────────────────────────────────────────────────

app.post('/api/runs/:id/approvals/:requestId', async (req, reply) => {
  const { id, requestId } = req.params as { id: string; requestId: string };
  const body = req.body as {
    allowed?: boolean;
    reason?: string;
    updatedInput?: Record<string, unknown>;
  };
  if (typeof body.allowed !== 'boolean') {
    return reply.code(400).send({ error: 'нужно поле allowed' });
  }

  const decision: Decision = body.allowed
    ? { allowed: true, updatedInput: body.updatedInput ?? null, by: 'operator' }
    : { allowed: false, reason: body.reason ?? 'оператор отклонил вызов', by: 'operator' };

  const ok = gate.resolve(id, requestId, decision);
  if (!ok) return reply.code(404).send({ error: 'запрос уже разрешён или устарел' });
  return { ok: true };
});

app.post('/api/runs/:id/questions/:requestId', async (req, reply) => {
  const { id, requestId } = req.params as { id: string; requestId: string };
  const body = req.body as { answers?: Record<string, string[]> };
  const ok = askGate.answer(id, requestId, body.answers ?? {});
  if (!ok) return reply.code(404).send({ error: 'вопрос уже отвечен или устарел' });
  return { ok: true };
});

app.post('/api/runs/:id/auto-approve', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const body = req.body as { stage?: string; on?: boolean };
  if (!isStageId(body.stage) || typeof body.on !== 'boolean') {
    return reply.code(400).send({ error: 'нужны поля stage (известный этап) и on' });
  }

  gate.setAutoApprove(id, body.stage, body.on);
  bus.emit({
    type: 'warning',
    runId: id,
    stage: body.stage,
    message: body.on
      ? `оператор включил автоодобрение на этапе ${body.stage} — дальнейшие вызовы этого этапа ` +
        `идут без подтверждения. Отказы политики продолжают действовать.`
      : `автоодобрение на этапе ${body.stage} выключено`,
  });
  return { ok: true };
});

app.post('/api/runs/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  // Отмена доходит до исполнителя: без этого SDK продолжал крутиться, тратя бюджет и
  // создавая новые запросы на одобрение на «отменённом» прогоне.
  live.run.cancel('прогон отменён оператором');
  bus.emit({ type: 'run_finished', runId: id, ok: false, note: 'отменён оператором' });
  return { ok: true };
});

/** Убрать завершённый виток из памяти: его состояние на диске, держать его тут незачем. */
app.delete('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });
  if (live.currentStage !== null) {
    return reply.code(409).send({ error: `этап ${live.currentStage} выполняется` });
  }

  live.run.cancel('прогон закрыт оператором');
  runs.delete(id);
  bus.forget(id);
  return { ok: true };
});

// ── поток событий ──────────────────────────────────────────────────────────

app.get('/ws', { websocket: true }, (socket, req) => {
  const runId = (req.query as { runId?: string }).runId;
  const send = (e: RunEvent): void => {
    if (runId !== undefined && 'runId' in e && e.runId !== runId) return;
    try {
      socket.send(JSON.stringify(e));
    } catch {
      // Сокет закрылся между проверкой и отправкой — не наша забота.
    }
  };

  if (runId !== undefined) for (const e of bus.replay(runId)) send(e);
  const off = bus.subscribe(send);
  socket.on('close', off);
});

// ── статика UI ─────────────────────────────────────────────────────────────

const webDist = join(import.meta.dirname, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
}

await app.listen({ port: config.runner.port, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(`Agent-SDLC Runner: http://127.0.0.1:${config.runner.port}`);
