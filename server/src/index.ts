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
  AutoApproveRules,
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
import { createProject } from './config/createProject.ts';
import { loadConfig, operatorProblem, requireProject } from './config/load.ts';
import { ProfileError, resolveAdHocProfile, resolveStartableProfile } from './config/profiles.ts';
import { listDir } from './fs/browse.ts';
import { fileStats, parseDiff } from './diff/parse.ts';
import { appendEvent, readPersistedEvents } from './eventLog.ts';
import { scanHistory } from './history.ts';
import { scopeViolations } from './gates/builtin/logic.ts';
import { normalizePlanPath } from './policy/paths.ts';
import { readArtifact, readDecision } from './artifacts/artifact.ts';
import { artifactPathOf } from './artifacts/paths.ts';
import { Run } from './run/Run.ts';
import { stopSandboxForProject } from './sandbox/registry.ts';
import { detectSandboxSpec } from './sandbox/detect.ts';
import { STAGES, isStageId, stageById } from './run/stages.ts';
import { badSlug } from './validation.ts';

const config = loadConfig();
const bus = new EventBus();

/**
 * Обзор каталогов из интерфейса сужен до одного дерева — на контейнерном развёртывании
 * это то же самое, что смонтировано внутрь. Не задано — ручка просто выключена, а не
 * открыта на всю файловую систему хоста по умолчанию.
 */
const browseRoot = process.env['SDLC_BROWSE_ROOT'];

interface LiveRun {
  run: Run;
  currentStage: StageId | null;
}

const runs = new Map<string, LiveRun>();

/**
 * И в шину (живые WS-подписчики), И на диск (архив на весь виток — см. `eventLog.ts`).
 * Единственная точка эмита в этом файле: до этого `ApprovalGate`/`AskGate` и пара
 * стихийных `bus.emit` в обработчиках HTTP слали события МИМО персиста — архивная лента
 * не содержала ни одного `tool_request`/`tool_resolved`/`tool_result`/`error`/`warning`,
 * то есть ни одного одобрения, отказа или вызова инструмента. `runs` — по `run.id`, а
 * ключ на диске — `slug`: ищем живой прогон по `e.runId`, чтобы узнать его project+slug.
 */
function emit(e: RunEvent): void {
  bus.emit(e);
  if ('runId' in e) {
    const live = runs.get(e.runId);
    if (live !== undefined) appendEvent(live.run.project.projectRoot, live.run.slug, e);
  }
}

const gate = new ApprovalGate({
  onPending: (p) =>
    emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      toolName: p.toolName,
      rawInput: p.rawInput,
      call: p.call,
      policy: p.policy,
      preview: p.preview,
      writeTargets: p.writeTargets,
      destructive: p.destructive,
      createdAt: p.createdAt,
    }),
  onResolved: (info, decision) =>
    emit({
      type: 'tool_resolved',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      decision,
    }),
});

const askGate = new AskGate({
  onPending: (p) =>
    emit({
      type: 'tool_request',
      runId: p.runId,
      stage: p.stage,
      requestId: p.requestId,
      toolName: 'AskHuman',
      rawInput: { questions: p.questions },
      call: { kind: 'ask_human', questions: p.questions },
      policy: { ok: true },
      preview: null,
      writeTargets: null,
      destructive: null,
      createdAt: p.createdAt,
    }),
  onAnswered: (info, answers) =>
    emit({
      type: 'tool_result',
      runId: info.runId,
      stage: info.stage,
      requestId: info.requestId,
      ok: true,
      summary: `ответы получены: ${Object.keys(answers).length}`,
      durationMs: 0,
    }),
});

const app = Fastify({ logger: { level: 'warn' } });
await app.register(websocket);

// ── валидация входа ────────────────────────────────────────────────────────

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
      // Строка и список приводятся к одной форме здесь: интерфейсу незачем знать про две.
      stages: Object.fromEntries(
        Object.entries(def.stages).map(([stage, v]) => [stage, Array.isArray(v) ? v : [v]]),
      ) as Record<StageId, string[]>,
    })),
  })),
  models: config.models.models,
  stages: STAGES.map((s) => ({ id: s.id, title: s.title, tools: s.tools })),
  browseEnabled: browseRoot !== undefined,
}));

// ── обзор каталогов и добавление проекта ────────────────────────────────────

app.get('/api/browse', (req, reply) => {
  if (browseRoot === undefined) {
    return reply.code(501).send({ error: 'обзор каталогов выключен: не задан SDLC_BROWSE_ROOT' });
  }
  // Fastify отдаёт массив для повторённого query-параметра (`?path=a&path=b`) —
  // без этой проверки такой запрос падал внутри listDir сырым `p.replace is not
  // a function` вместо внятной ошибки валидации.
  const { path } = req.query as { path?: unknown };
  if (path !== undefined && typeof path !== 'string') {
    return reply.code(400).send({ error: 'параметр path должен быть одной строкой' });
  }
  try {
    return listDir(browseRoot, path);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.post('/api/projects', (req, reply) => {
  // Та же граница, что у GET /api/browse: без SDLC_BROWSE_ROOT нет дерева, к которому
  // можно сузить projectRoot, и ручка обязана быть выключена целиком, а не принимать
  // произвольный путь с диска сервера.
  if (browseRoot === undefined) {
    return reply.code(501).send({ error: 'добавление проекта выключено: не задан SDLC_BROWSE_ROOT' });
  }
  const body = (req.body ?? {}) as { name?: string; projectRoot?: string };
  if (typeof body.name !== 'string' || typeof body.projectRoot !== 'string') {
    return reply.code(400).send({ error: 'нужны поля name и projectRoot' });
  }
  try {
    const project = createProject(config, {
      name: body.name,
      projectRoot: body.projectRoot,
      browseRoot,
    });
    return {
      name: project.name,
      projectRoot: project.projectRoot,
      activeProfile: project.activeProfile,
      maxBudgetUsd: project.maxBudgetUsd,
      profiles: Object.entries(project.profiles).map(([name, def]) => ({
        name,
        label: def.label,
        // Та же нормализация формы, что и в GET /api/config. Без неё ответ этой ручки
        // уходил прямо в состояние интерфейса, и один массив профилей содержал записи
        // двух форм: строка и список. Компилятор молчал — хендлер без generic'а.
        stages: Object.fromEntries(
          Object.entries(def.stages).map(([stage, v]) => [stage, Array.isArray(v) ? v : [v]]),
        ) as Record<StageId, string[]>,
      })),
    };
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

/**
 * Черновик `.sdlc/sandbox.json` по составу проекта — ничего не пишет и не поднимает Docker,
 * только читает манифесты. Оператор сохраняет результат сам (или правит перед сохранением);
 * ручка нужна там, где не хочется писать спеку с нуля вручную для нового проекта.
 */
app.get('/api/projects/:name/sandbox/detect', (req, reply) => {
  const { name } = req.params as { name: string };
  try {
    const project = requireProject(config, name);
    return detectSandboxSpec(project.projectRoot);
  } catch (e) {
    return reply.code(404).send({ error: (e as Error).message });
  }
});

// ── прогоны ────────────────────────────────────────────────────────────────

app.post('/api/runs', async (req, reply) => {
  const body = req.body as {
    project?: string;
    slug?: string;
    profile?: string;
    /** Правка профиля на один виток. На диск не сохраняется — см. `resolveAdHocProfile`. */
    stages?: Record<string, string | string[]>;
  };
  if (typeof body.project !== 'string' || typeof body.slug !== 'string') {
    return reply.code(400).send({ error: 'нужны поля project и slug' });
  }

  const slugProblem = badSlug(body.slug);
  if (slugProblem !== null) return reply.code(400).send({ error: slugProblem });

  // Имя оператора проверяется ЗДЕСЬ, а не при загрузке конфига: без интерфейса человек не
  // прочитал бы, что именно чинить. Но и стартовать виток с безымянным «Утвердил» нельзя —
  // такой артефакт методология считает незаполненным, а вердикт роняет.
  const operatorIssue = operatorProblem(config.runner);
  if (operatorIssue !== null) return reply.code(400).send({ error: operatorIssue });

  const slug = body.slug;

  try {
    const project = requireProject(config, body.project);

    // Без этой проверки два live-прогона одного проекта могли получить один и тот же
    // slug (двойной клик, незакрытый предыдущий процесс) — `runs` индексирована по
    // `run.id`, не по slug, и клик «открыть» в HistoryList (`App.tsx::onOpen`, ищет по
    // slug+project) уходил в первый по порядку вставки, не обязательно в актуальный.
    // `currentStage !== null`, а не просто присутствие в `runs`: тот же критерий, что у
    // `DELETE /api/runs/:id` ниже — иначе отменённый или просто не «убранный» руками
    // прошлый прогон того же slug навсегда блокировал бы перезапуск 409-м, хотя реально
    // ничего не выполняется.
    const clashing = [...runs.values()].find(
      (lr) => lr.run.project.name === project.name && lr.run.slug === slug && lr.currentStage !== null,
    );
    if (clashing !== undefined) {
      return reply
        .code(409)
        .send({ error: `виток «${slug}» уже идёт для проекта «${project.name}» (id ${clashing.run.id})` });
    }

    const profileName = body.profile ?? project.activeProfile;
    // Правило рецензента проверяется здесь: виток с ревью слабее исполнителя не стартует.
    const profile =
      body.stages === undefined || Object.keys(body.stages).length === 0
        ? resolveStartableProfile(project, config.models, profileName)
        : resolveAdHocProfile(project, config.models, body.stages, profileName);

    const run = new Run({
      config,
      project,
      profile,
      slug,
      gate,
      askGate,
      emit,
    });

    runs.set(run.id, { run, currentStage: null });
    emit({
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
    currency: profileCurrency(run.profile.routes),
    status: run.status,
    stage: currentStage,
    chunk: run.chunk,
    attempt: run.attempt,
    usage: run.totalUsage,
  })),
);

/**
 * Единая валюта маршрутов профиля — см. `RunSummary.currency`. Смешанный профиль отдаёт
 * USD: сумма в двух валютах честной подписи не имеет, статус-кво остаётся как был.
 */
function profileCurrency(routes: Record<string, { providerDef: { currency?: string } }>): string {
  const set = new Set(Object.values(routes).map((r) => r.providerDef.currency ?? 'USD'));
  const only = [...set];
  return only.length === 1 && only[0] !== undefined ? only[0] : 'USD';
}

app.get('/api/history', (req, reply) => {
  const { project } = req.query as { project?: unknown };
  if (typeof project !== 'string') {
    return reply.code(400).send({ error: 'нужен параметр project' });
  }
  try {
    const p = requireProject(config, project);
    const liveSlugs = new Set(
      [...runs.values()]
        .filter((lr) => lr.run.project.name === p.name)
        .map((lr) => lr.run.slug),
    );
    return scanHistory(p.projectRoot, liveSlugs);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

/**
 * Полная лента событий витка — АРХИВНЫЙ путь, читает с диска, не из живого `runs`/`bus`.
 * Работает и для витка, который прямо сейчас идёт (лента дописывается по ходу), и для уже
 * закрытого/убранного из живого списка — `readPersistedEvents` не смотрит на `runs` вообще.
 * `GET /api/runs/:id` остаётся источником LIVE-детали (текущий этап, статус, WS) — это два
 * разных вопроса: «что происходит сейчас» и «что произошло за весь виток».
 */
app.get('/api/history/:slug/events', (req, reply) => {
  const { slug } = req.params as { slug: string };
  const { project } = req.query as { project?: unknown };
  if (typeof project !== 'string') {
    return reply.code(400).send({ error: 'нужен параметр project' });
  }
  try {
    const p = requireProject(config, project);
    return readPersistedEvents(p.projectRoot, slug);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get('/api/runs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const { run, currentStage } = live;
  const detail: RunDetail = {
    runId: run.id,
    serverNow: Date.now(),
    slug: run.slug,
    project: run.project.name,
    projectRoot: run.project.projectRoot,
    profile: run.profile.name,
    currency: profileCurrency(run.profile.routes),
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
      // У handoff'а вход двойной, и предусловия у входов разные — см. `abortBlockers`.
      abortBlockers: s.id === 'handoff' ? run.blockers(s.id, { abortHandoff: true }) : null,
      produces: s.produces(run.ctx),
      // Факт с диска тем же чтением, что блокеры: клиентская эвристика «дальний этап без
      // блокеров = всё до него пройдено» врала на этапах с общими предусловиями (ask и
      // plan разблокированы сразу после intent, до всякой разведки) — см. StageInfo.produced.
      produced: (() => {
        const out = s.produces(run.ctx);
        return out.length > 0 && out.every((p) => existsSync(p));
      })(),
      decision: s.humanGate,
      // Тем же разбором, что и предусловие следующего этапа (`granted()` в stages.ts):
      // «записано» — это `readDecision(...).state === 'granted'`, а не факт, что поле
      // вообще существует в шаблоне.
      decisionRecorded:
        s.humanGate === null
          ? false
          : (() => {
              const path = artifactPathOf(run.paths, s.humanGate.artifact, run.chunk, run.attempt);
              const a = readArtifact(path);
              return a.exists && readDecision(a.text, s.humanGate.label).state === 'granted';
            })(),
    })),
    pendingApprovals: gate.list().filter((p) => p.runId === id),
    pendingQuestions: askGate.list().filter((p) => p.runId === id),
    gateResults: run.gateResults,
    mcpServers: run.mcpServers(),
    mcpStage: run.mcpStageInfo(),
    gatesAborted: run.gatesAborted,
    verdict: run.lastVerdict,
    redCause: run.lastRedCause,
    progressCloseness: run.progressCloseness,
    progressClosenessWarn: config.runner.limits.progressClosenessWarn,
    metrics: run.metrics,
    escalation: run.escalation,
    iterations: run.iterations,
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

  const body = req.body as {
    artifact?: string;
    label?: string;
    granted?: boolean;
    note?: string;
    chunk?: number;
    attempt?: number;
  };
  if (typeof body.artifact !== 'string' || typeof body.label !== 'string') {
    return reply.code(400).send({ error: 'нужны поля artifact и label' });
  }
  // Умолчания нет намеренно: «одобрить» и «отклонить» — разные решения человека, и
  // угадывать за него, какое из них он имел в виду, рантайм не должен.
  if (typeof body.granted !== 'boolean') {
    return reply.code(400).send({ error: 'нужно поле granted: true (одобрено) или false (нет)' });
  }

  try {
    const value = live.run.recordDecision({
      artifact: body.artifact,
      label: body.label,
      granted: body.granted,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
      ...(typeof body.chunk === 'number' ? { chunk: body.chunk } : {}),
      ...(typeof body.attempt === 'number' ? { attempt: body.attempt } : {}),
    });
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
      emit({
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
  const body = req.body as { answers?: Record<string, string[]>; note?: string };
  const ok = askGate.answer(id, requestId, body.answers ?? {}, body.note);
  if (!ok) return reply.code(404).send({ error: 'вопрос уже отвечен или устарел' });
  return { ok: true };
});

app.post('/api/runs/:id/auto-approve', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const body = req.body as { stage?: string; rules?: Partial<AutoApproveRules> };
  if (!isStageId(body.stage) || typeof body.rules !== 'object' || body.rules === null) {
    return reply.code(400).send({ error: 'нужны поля stage (известный этап) и rules' });
  }

  // Каждое правило читается явно: отсутствующее поле — это «спрашивать», а не «разрешить».
  const rules: AutoApproveRules = {
    planWrites: body.rules.planWrites === true,
    bash: body.rules.bash === true,
    rest: body.rules.rest === true,
    mcpWrites: body.rules.mcpWrites === true,
  };
  gate.setAutoApprove(id, body.stage, rules);

  const on = [
    rules.planWrites ? 'правки внутри files_to_touch' : null,
    rules.bash ? 'команды оболочки' : null,
    rules.rest ? 'всё остальное, включая запись вне плана' : null,
  ].filter((v): v is string => v !== null);

  emit({
    type: 'warning',
    runId: id,
    stage: body.stage,
    message:
      on.length === 0
        ? `автоодобрение на этапе ${body.stage} выключено — спрашивается каждый вызов`
        : `оператор включил автоодобрение на этапе ${body.stage}: ${on.join(', ')}. ` +
          `Отказы политики продолжают действовать.`,
  });
  return { ok: true };
});

/**
 * Патч попытки и разметка «в плане / вне плана».
 *
 * Отдельной ручкой, а не полем `RunDetail`: патч бывает в сотни килобайт, а состояние
 * перезапрашивается на каждый записанный артефакт — гонять его туда-обратно незачем.
 */
app.get('/api/runs/:id/diff', (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  const { run } = live;
  const patch = readArtifact(run.paths.chunkDiff(run.chunk, run.attempt));
  if (!patch.exists) {
    return reply.code(404).send({ error: 'патч этой попытки ещё не собран' });
  }

  // «Вне плана» считается ТЕМ ЖЕ правилом, что и у политики, а не похожим на него.
  // Сырое `planFiles.includes(f)` расходилось с ней на первом же плане, где модель
  // написала `./src/a.ts` или абсолютный путь: политика запись разрешала, scope-гейт был
  // зелёным, а просмотр красил файл жёлтым с подписью «запись туда отклоняется политикой»
  // — и оператор шёл чинить несуществующее нарушение. `scopeViolations` нормализует обе
  // стороны через `normalizePlanPath`, ровно как `policy/planScope.ts`.
  const planFiles = run.planFilesFor('verify') ?? [];
  const files = parseDiff(patch.text).files;
  const outside = new Set(
    scopeViolations(files, planFiles, run.project.projectRoot).map((v) => v.path),
  );
  // Счётчики строк — тем же разбором, что и список файлов: клиент раньше считал их сам по
  // тексту патча регуляркой на `+++`/`---`, и это тот же класс дефекта, что уже чинили
  // здесь для списка файлов.
  const stats = new Map(fileStats(patch.text).map((s) => [s.path, s]));

  return {
    chunk: run.chunk,
    attempt: run.attempt,
    patch: patch.text,
    files: files.map((f) => ({
      path: f,
      inPlan: !outside.has(normalizePlanPath(run.project.projectRoot, f)),
      adds: stats.get(f)?.adds ?? 0,
      dels: stats.get(f)?.dels ?? 0,
    })),
  };
});

app.post('/api/runs/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  const live = liveRun(id);
  if (live === null) return reply.code(404).send({ error: 'прогон не найден' });

  // Отмена доходит до исполнителя: без этого SDK продолжал крутиться, тратя бюджет и
  // создавая новые запросы на одобрение на «отменённом» прогоне.
  live.run.cancel('прогон отменён оператором');
  // `run_finished` здесь НЕ шлётся: отмена — это запрос остановки, а не её факт. Лента
  // печатала «◼ прогон завершён» в тот момент, когда шапка той же страницы честно
  // показывала «останавливается…», и оператор уходил, считая виток остановленным, пока
  // исполнитель ещё работал и тратил бюджет. Конец приходит своим `stage_done`/`error`.
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
  // Внешние MCP-серверы гаснут вместе с витком: stdio-сервер — это живой процесс, и
  // закрытый прогон не должен оставлять его висеть до перезапуска раннера.
  void live.run.dispose();
  const { projectRoot, name: projectName } = live.run.project;
  runs.delete(id);
  bus.forget(id);

  // Гасим контейнер песочницы проекта, только если это был ПОСЛЕДНИЙ живой прогон на нём —
  // у оператора может быть открыто несколько витков одного проекта одновременно, и остановка
  // по закрытию одного из них не должна выбивать почву из-под другого.
  const stillLive = [...runs.values()].some((l) => l.run.project.projectRoot === projectRoot);
  if (!stillLive) void stopSandboxForProject(projectRoot, projectName);

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

/**
 * Адрес прослушивания. По умолчанию — только петля: аутентификации у сервиса нет, и
 * доступный из сети Agent-SDLC Runner означает чужой доступ к правке файлов проекта и к
 * запуску команд оболочки.
 *
 * `SDLC_HOST=0.0.0.0` нужен ровно для контейнера: там петля видна только изнутри, и
 * порт, проброшенный на хост, всё равно никуда не ведёт. Границей в этом случае служит
 * публикация порта (`127.0.0.1:8030:8030` в compose), а не адрес внутри контейнера.
 */
const host = process.env['SDLC_HOST'] ?? '127.0.0.1';

await app.listen({ port: config.runner.port, host });
// eslint-disable-next-line no-console
console.log(`Agent-SDLC Runner: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${config.runner.port}`);
