/**
 * Эталон поведения `Run.runStage` — сквозной виток на подменной модели.
 *
 * Страховка рефакторинга «этап — отдельный модуль»: логика этапов переезжает из `Run.ts` в
 * `run/stages/**`, и поведение обязано остаться тем же байт в байт. Точечные тесты покрывают
 * отдельные механизмы, но не порядок фаз внутри `runStage` — а переносится именно он. Здесь
 * фиксируется всё, что виток делает наблюдаемо: поток событий, результаты этапов, что уходило
 * в модель, и файлы витка на диске.
 *
 * Виток мелкого контура (разведка и вопросы пропускаются по построению) на временном
 * git-репозитории. Модель — подменный OpenAI-совместимый сервер: ответ выбирается по метке
 * этапа в системном промпте (у каждого этапа своя очередь), записи одобряет колбэк гейта.
 * Этап не обязан пройти — эталон фиксирует, что происходит сейчас.
 *
 * Эталон пишется `UPDATE_GOLDEN=1 node --test test/runStageGolden.test.ts` — только на коде, в
 * поведении которого уверены. Без файла эталона тест падает, а не создаёт его молча.
 */

import { deepStrictEqual, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { Run } from '../src/run/Run.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'runStage');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ── проект ────────────────────────────────────────────────────────────────

const GATES = [
  '# Набор гейтов: demo',
  '',
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да — минимум | этап 6 | `node -e "process.exit(0)"` |',
  '| Тесты | да — минимум | этап 6 | `node -e "process.exit(0)"` |',
  '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки diff с files_to_touch |',
  '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
  '| Ревью независимым агентом | да — минимум | этап 6 | агент на более сильной модели |',
  '',
].join('\n');

const TEMPLATES: Record<string, string> = {
  'intent.template.md': [
    '# Задача: ‹название›',
    '',
    '- **Контур:** ‹полный / мелкий›',
    '- **Ветка витка:** ‹sdlc/слаг›',
    '',
    '## Приёмка',
    '',
    '| id | Пункт | Как проверить |',
    '|---|---|---|',
    '| claim-1 | ‹поведение› | ‹критерий› |',
    '',
  ].join('\n'),
  'readiness.template.md': '# Готовность: ‹название витка›\n\n- Прогон 1: ‹итог›\n',
  'plan.template.md': [
    '# План: ‹название витка›',
    '',
    '- **Одобрение:** ‹подпись и дата›',
    '',
    '## files_to_touch',
    '',
    '| Путь | Что делаем |',
    '|---|---|',
    '| ‹путь› | ‹что› |',
    '',
  ].join('\n'),
  'chunk-journal.template.md': [
    '# Журнал chunk 1',
    '',
    '- **Подтвердил:** ‹подпись и дата›',
    '',
    '## Что сделано',
    '',
    '‹что сделано›',
    '',
  ].join('\n'),
  'verification-report.template.md': [
    '# Отчёт приёмки: ‹название витка›',
    '',
    '## Гейты',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    '| Сборка | ‹статус› | ‹итог› |',
    '',
    '## 1. Пункты приёмки',
    '',
    '| id | Пункт | passed | Чем подтверждён | Что чинить |',
    '|---|---|---|---|---|',
    '| claim-1 | ‹пункт› | ‹статус› | ‹чем› | ‹что› |',
    '',
  ].join('\n'),
  'handoff.template.md': '# Передача: ‹название витка›\n\n- **Приёмка:** ‹подпись и дата›\n\n## Итог\n\n‹итог›\n',
  'exploration-report.template.md': [
    '# Отчёт разведки: ‹название витка›',
    '',
    '## Карта кодовой базы',
    '',
    '| Файл | Что там сейчас | Что меняем |',
    '|---|---|---|',
    '| ‹путь› | ‹что› | ‹что› |',
    '',
    '**Решение человека о полноте:** ‹подпись и дата›',
    '',
  ].join('\n'),
};

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.com',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
}

function makeProject(gates: string = GATES): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-golden-')));
  roots.push(root);
  for (const stage of STAGE_ORDER) {
    mkdirSync(join(root, 'skills', `sdlc-${stage}`), { recursive: true });
    writeFileSync(join(root, 'skills', `sdlc-${stage}`, 'SKILL.md'), `СКИЛЛ ${stage}: заполни артефакт этапа по форме.\n`);
  }
  mkdirSync(join(root, 'methodology', 'templates'), { recursive: true });
  for (const [name, text] of Object.entries(TEMPLATES)) writeFileSync(join(root, 'methodology', 'templates', name), text);
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'export const version = 1;\n');
  mkdirSync(join(root, '.sdlc'), { recursive: true });
  writeFileSync(join(root, '.sdlc', 'gates.md'), gates);
  writeFileSync(join(root, '.gitignore'), 'skills/\nmethodology/\nagents/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'база');
  git(root, 'checkout', '-q', '-b', 'sdlc/demo');
  return root;
}

// ── подменная модель ──────────────────────────────────────────────────────

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
type Queues = Partial<Record<StageId, Reply[]>>;

interface RequestSummary {
  stage: string;
  messages: number;
  tools: string[];
  lastRole: string;
}

async function startModel(queues: Queues): Promise<{ baseUrl: string; requests: RequestSummary[]; close: () => void }> {
  const requests: RequestSummary[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages: { role: string; content: string | null }[];
        tools?: { function: { name: string } }[];
      };
      const system = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
      const stage = /СКИЛЛ (\w+):/.exec(system)?.[1] ?? 'вне этапа';
      requests.push({
        stage,
        messages: parsed.messages.length,
        tools: (parsed.tools ?? []).map((t) => t.function.name).sort(),
        lastRole: parsed.messages.at(-1)?.role ?? '',
      });
      const reply = queues[stage as StageId]?.shift() ?? { text: 'готово' };
      const message =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: `call${++seq}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }],
            };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

// ── виток ─────────────────────────────────────────────────────────────────

function makeRun(root: string, baseUrl: string, events: RunEvent[], routeOver: Partial<ResolvedRoute> = {}): Run {
  const route = (stage: StageId): ResolvedRoute => ({
    stage,
    provider: 'stub',
    providerDef: { flow: 'loop', kind: 'openai-compat', baseUrl },
    model: 'm',
    modelId: 'm',
    flow: 'loop',
    rank: 1,
    params: null,
    leanTools: false,
    formFill: false,
    claimFill: false,
    reviewFill: false,
    skipTurnAfterReviewFill: false,
    planAxisFill: false,
    stepFill: false,
    compactForms: 'off',
    exploreIndex: false,
    exploreFill: false,
    ...routeOver,
  });
  const routes = Object.fromEntries(STAGE_ORDER.map((s) => [s, route(s)])) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<StageId, ResolvedRoute[]>;
  const profile: ResolvedProfile = { name: 'demo', label: 'demo', routes, ensemble };
  const project: ProjectConfig = { name: 'demo', projectRoot: root, activeProfile: 'demo', maxBudgetUsd: 1, profiles: {} };
  const config = {
    runner: {
      port: 0,
      operator: 'Гриц',
      skillsDir: join(root, 'skills'),
      agentsDir: join(root, 'agents'),
      methodologyDir: join(root, 'methodology'),
      limits: {
        maxToolResultBytes: 4000,
        localMaxToolResultBytes: 4000,
        readRangeRequiredAboveBytes: 4000,
        maxIterationsPerStage: 8,
        gateTimeoutMs: 60_000,
        progressClosenessWarn: 0.9,
        chatTimeoutMs: 10_000,
      },
    },
    models: { models: [] },
    projects: new Map(),
    mcp: new Map(),
  } as unknown as LoadedConfig;

  // Оператор-автомат: каждая запись одобряется сразу, как только гейт её предъявил.
  let gate: ApprovalGate | null = null;
  gate = new ApprovalGate({
    onPending: (p) => {
      setImmediate(() => gate?.resolve(p.runId, p.requestId, { allowed: true, updatedInput: null, by: 'operator' }));
    },
    onResolved: () => {},
  });
  return new Run({
    config,
    project,
    profile,
    slug: 'demo',
    gate,
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: (e) => events.push(e),
  });
}

// ── нормализация ─────────────────────────────────────────────────────────

const VOLATILE_KEYS = new Set(['durationMs', 'waitMs', 'waitedMs', 'createdAt', 'startedAt', 'finishedAt']);

function normalize(value: unknown, root: string): unknown {
  const rootForms = [root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\'), root.replace(/\\/g, '\\\\')];
  let text = JSON.stringify(value, (key, v: unknown) => (VOLATILE_KEYS.has(key) && typeof v === 'number' ? 0 : v));
  for (const form of rootForms.sort((a, b) => b.length - a.length)) text = text.split(form).join('<ROOT>');
  text = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<ID>')
    .replace(/\b[0-9a-f]{40}\b/g, '<SHA>')
    .replace(/index [0-9a-f]{7,40}\.\.[0-9a-f]{7,40}/g, 'index <SHA>..<SHA>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<DATETIME>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/(?<![\d:])\d{2}:\d{2}(:\d{2})?(?![\d:])/g, '<TIME>')
    // Длительности: `\b` по кириллице не работает (граница считается по ASCII), поэтому конец
    // единицы — явным «не буква и не цифра дальше».
    .replace(/\d+(?:[.,]\d+)?\s?(?:мин|мс|ms|с|s)(?![\p{L}\d])/gu, '<DUR>')
    // Базовый снимок дерева chunk'а хранит хэши грязных файлов, а метрики витка несут время.
    .replace(/(metrics\.(?:json|md)\\*": \\*")[0-9a-f]{32}/g, '$1<HASH>');
  return JSON.parse(text);
}

function sdlcFiles(root: string): Record<string, string> {
  const dir = join(root, '.sdlc', 'demo');
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      // Лента и метрики — производные от событий и времени: лента уже сравнивается целиком.
      else if (!/^\.events\.ndjson$|^metrics\.(json|md)$/.test(name)) out[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  out['src/app.js'] = readFileSync(join(root, 'src', 'app.js'), 'utf8');
  return out;
}

function compareWithGolden(name: string, actual: unknown): void {
  const file = join(FIXTURES, `${name}.json`);
  if (UPDATE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  ok(existsSync(file), `нет эталона ${file} — снять: UPDATE_GOLDEN=1 node --test test/runStageGolden.test.ts`);
  deepStrictEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Один сценарий: проект, модель с очередями ответов и шаги витка. Шаг возвращает результат
 * этапа либо текст исключения (запись решения на испорченной форме) — оба идут в эталон.
 */
async function scenario(
  name: string,
  queues: Queues,
  steps: (run: Run, results: Record<string, unknown>) => Promise<void>,
  gates: string = GATES,
  opts: {
    route?: Partial<ResolvedRoute>;
    /**
     * Порядок событий и запросов не сравнивается — для сценариев с параллельными пачками
     * запросов (вложенное дозаполнение по полям), где порядок ответов сети не определён.
     * Ответы модели в таких сценариях одинаковы, иначе содержимое зависело бы от порядка.
     */
    unordered?: boolean;
  } = {},
): Promise<void> {
  const root = makeProject(gates);
  const model = await startModel(queues);
  const events: RunEvent[] = [];
  const results: Record<string, unknown> = {};
  const run = makeRun(root, model.baseUrl, events, opts.route);
  try {
    await steps(run, results);
  } finally {
    await run.dispose();
    model.close();
  }
  const snapshot = normalize(
    {
      results: Object.fromEntries(
        Object.entries(results).map(([k, r]) => (typeof r === 'string' ? [k, r] : [k, { ...(r as object), usage: undefined }])),
      ),
      events,
      requests: model.requests,
      files: sdlcFiles(root),
    },
    root,
  ) as { events: unknown[]; requests: unknown[] };
  if (opts.unordered === true) {
    const byJson = (a: unknown, b: unknown): number => JSON.stringify(a).localeCompare(JSON.stringify(b));
    snapshot.events.sort(byJson);
    snapshot.requests.sort(byJson);
  }
  compareWithGolden(name, snapshot);
}

function decide(run: Run, results: Record<string, unknown>, artifact: 'plan' | 'journal', label: string): void {
  try {
    run.recordDecision({ artifact, label, granted: true });
  } catch (e) {
    results[`decision:${artifact}:${run.attempt}`] = (e as Error).message;
  }
}

// ── ответы модели ─────────────────────────────────────────────────────────

const write = (file_path: string, content: string): Reply => ({ tool: 'Write', args: { file_path, content } });

const INTENT_REPLIES = (): Reply[] => [
  write(
    '.sdlc/demo/intent.md',
    [
      '# Задача: demo',
      '',
      '- **Контур:** мелкий',
      '- **Ветка витка:** sdlc/demo',
      '',
      '## Приёмка',
      '',
      '| id | Пункт | Как проверить |',
      '|---|---|---|',
      '| claim-1 | версия поднята до 2 | `version === 2` |',
      '',
    ].join('\n'),
  ),
  write('.sdlc/demo/readiness.md', '# Готовность: demo\n\n- Прогон 1: готова\n'),
  { text: 'готово' },
];

const PLAN_REPLIES = (): Reply[] => [
  write(
    '.sdlc/demo/plan.md',
    [
      '# План: demo',
      '',
      '- **Одобрение:** ‹подпись и дата›',
      '',
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| src/app.js | поднять версию |',
      '',
    ].join('\n'),
  ),
  { text: 'план готов' },
];

const CHUNK_REPLIES = (): Reply[] => [
  write('src/app.js', 'export const version = 2;\n'),
  write('.sdlc/demo/chunk-1-journal.md', '# Журнал chunk 1\n\n- **Подтвердил:** ‹подпись и дата›\n\n## Что сделано\n\nверсия поднята до 2\n'),
  { text: 'правка сделана' },
];

async function toChunkDone(run: Run, results: Record<string, unknown>): Promise<void> {
  for (const stage of ['intent', 'explore', 'ask', 'plan'] as const) results[stage] = await run.runStage(stage);
  decide(run, results, 'plan', 'Одобрение');
  results['chunk:1'] = await run.runStage('chunk');
  decide(run, results, 'journal', 'Подтвердил');
}

describe('runStage: эталон поведения витка', () => {
  it('мелкий контур: intent → plan → chunk → verify → handoff (обрыв)', async () => {
    await scenario(
      'small-contour',
      {
        intent: INTENT_REPLIES(),
        plan: PLAN_REPLIES(),
        chunk: CHUNK_REPLIES(),
        verify: [{ text: 'проверено' }],
        handoff: [write('.sdlc/demo/handoff.md', '# Передача: demo\n\n- **Приёмка:** ‹подпись и дата›\n\n## Итог\n\nвиток оборван\n'), { text: 'передано' }],
      },
      async (run, results) => {
        await toChunkDone(run, results);
        results['verify:1'] = await run.runStage('verify');
        results['handoff'] = await run.runStage('handoff', { abortHandoff: true });
      },
    );
  });

  const INTENT_FULL = (): Reply[] => [
    write(
      '.sdlc/demo/intent.md',
      [
        '# Задача: demo',
        '',
        '- **Контур:** полный',
        '- **Ветка витка:** sdlc/demo',
        '',
        '## Коротко',
        '',
        'Поднять версию приложения до 2.',
        '',
        '## Что делаем',
        '',
        '- меняем константу версии в `src/app.js`',
        '',
        '## Приёмка',
        '',
        '| id | Пункт | Как проверить |',
        '|---|---|---|',
        '| claim-1 | версия поднята до 2 | `version === 2` |',
        '| claim-2 [edge] | версия — число, а не строка | `typeof version === "number"` |',
        '| claim-3 [edge] | других экспортов не появилось | список экспортов модуля |',
        '',
      ].join('\n'),
    ),
    write('.sdlc/demo/readiness.md', '# Готовность: demo\n\n- Прогон 1: готова\n'),
    { text: 'готово' },
  ];
  const report = (path: string): string =>
    [
      '# Отчёт разведки: demo',
      '',
      '## Карта кодовой базы',
      '',
      '| Файл | Что там сейчас | Что меняем |',
      '|---|---|---|',
      `| ${path} | константа версии | поднять до 2 |`,
      '',
      '**Решение человека о полноте:** ‹подпись и дата›',
      '',
    ].join('\n');

  it('полный контур: разведка с сочинённым путём в карте → страж → исправленная карта → ask пропущен', async () => {
    await scenario(
      'full-contour-explore',
      {
        intent: INTENT_FULL(),
        explore: [
          write('.sdlc/demo/exploration-report.md', report('src/missing.js')),
          { text: 'разведка готова' },
          write('.sdlc/demo/exploration-report.md', report('src/app.js')),
          { text: 'карта исправлена' },
        ],
      },
      async (run, results) => {
        for (const stage of ['intent', 'explore', 'ask'] as const) results[stage] = await run.runStage(stage);
      },
    );
  });

  it('полный контур, конвейер разведки (exploreFill): слепой лист, индекс, вложенное дозаполнение', async () => {
    await scenario(
      'explore-fill',
      { intent: INTENT_FULL() },
      async (run, results) => {
        results['intent'] = await run.runStage('intent');
        results['explore'] = await run.runStage('explore');
      },
      GATES,
      { route: { exploreFill: true }, unordered: true },
    );
  });

  it('гейт «Разбор последствий»: план без осей → напоминание стража → каноничная таблица → verify', async () => {
    const planWithoutAxes = [
      '# План: demo',
      '',
      '- **Одобрение:** ‹подпись и дата›',
      '',
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| src/app.js | поднять версию |',
      '',
    ].join('\n');
    const axes = ['Безопасность', 'Ресурсы и скорость', 'Отказы зависимостей', 'Настройки', 'Совместимость и данные', 'Наблюдаемость'];
    const planWithAxes = [
      planWithoutAxes,
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      ...axes.map((a) => `| ${a} | нет | шаг 1: не трогаем | н/п — ось не затронута |`),
      '',
    ].join('\n');
    await scenario(
      'plan-axes',
      {
        intent: INTENT_REPLIES(),
        plan: [write('.sdlc/demo/plan.md', planWithoutAxes), { text: 'план готов' }, write('.sdlc/demo/plan.md', planWithAxes), { text: 'оси разобраны' }],
        chunk: CHUNK_REPLIES(),
        verify: [{ text: 'проверено' }],
      },
      async (run, results) => {
        await toChunkDone(run, results);
        results['axisProblems'] = run.axisProblems();
        results['earlyGateRows'] = run.earlyGateRows();
        results['verify:1'] = await run.runStage('verify');
      },
      GATES.replace('| Сборка |', '| Разбор последствий | да | этап 4 | проза |\n| Сборка |'),
    );
  });

  it('записи рецензента и повтор: RecordClaim ❌ → вторая попытка chunk с тем же патчем → verify', async () => {
    const claim: Reply = {
      tool: 'RecordClaim',
      args: { id: 'claim-1', status: '❌', evidence: 'src/app.js:1', what_to_fix: 'версия должна быть 3' },
    };
    const finding: Reply = {
      tool: 'RecordFinding',
      args: { section: 'review', text: 'версия поднята не до того значения', evidence: 'src/app.js:1' },
    };
    await scenario(
      'retry-records',
      {
        intent: INTENT_REPLIES(),
        plan: PLAN_REPLIES(),
        chunk: [...CHUNK_REPLIES(), write('src/app.js', 'export const version = 2;\n'), { text: 'повтор без изменений' }],
        verify: [claim, finding, { text: 'проверено' }, claim, { text: 'проверено снова' }],
      },
      async (run, results) => {
        await toChunkDone(run, results);
        results['verify:1'] = await run.runStage('verify');
        results['verdict:1'] = run.lastVerdict;
        results['nextAttempt'] = run.nextAttempt();
        results['chunk:2'] = await run.runStage('chunk');
        results['verify:2'] = await run.runStage('verify');
        results['verdict:2'] = run.lastVerdict;
        results['closeness'] = run.progressCloseness;
      },
    );
  });
});
