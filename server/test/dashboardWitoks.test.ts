/**
 * `dashboard/witoks.ts`, `detail.ts`, `artifactAccess.ts` — витки на диске в дашборде:
 * источник (раннер / терминал / живой), состояния этапов, детали этапа из ленты, вердикт
 * рантайма этой машины и отдача содержимого только по имени из словаря.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { emptyUsage } from '@sdlc-runner/shared';
import type { RunEvent, RunSummary } from '@sdlc-runner/shared';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { allowedWitokName, resolveWitokArtifact } from '../src/dashboard/artifactAccess.ts';
import { indexEvents } from '../src/dashboard/events.ts';
import { badWitokSlug, dashboardArtifact, dashboardBody, dashboardDetail, dashboardList, dashboardProjects } from '../src/dashboard/index.ts';
import { projectByKey } from '../src/dashboard/projects.ts';
import { scanWitoks, witokCard } from '../src/dashboard/witoks.ts';
import { writeRunVerdict } from '../src/run/verdictStore.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-dash-witoks-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const [project] = dashboardProjects([
  { name: 'demo', projectRoot: root },
  { name: 'demo-alias', projectRoot: root },
]);
if (project === undefined) throw new Error('нет проекта');

const events = (list: RunEvent[]): string => list.map((e) => JSON.stringify(e)).join('\n') + '\n';

// Терминальный виток: только канонические артефакты, без ленты и служебных файлов.
const term = new WitokPaths(root, 'term');
writeArtifact(term.intent, '# Задача: терминальная задача\n');
writeArtifact(term.plan, '# План\n\n- **Одобрение:** ‹имя, дата›\n');
writeArtifact(term.chunkJournal(2), '# Журнал\n\n## Попытки\n\n| K | Итог |\n|---|---|\n| 1 | red |\n| 3 | ok |\n');

// Архивный виток раннера: лента с двумя запусками и проваленной разведкой.
const ui = new WitokPaths(root, 'ui-archive');
writeArtifact(ui.intent, '# Задача: задача раннера\n');
writeArtifact(
  ui.events,
  events([
    { type: 'run_started', runId: 'r1', slug: 'ui-archive', profile: 'p', projectRoot: root },
    { type: 'stage_started', runId: 'r1', stage: 'intent', flow: 'loop', provider: 'ollama', model: 'm1', chunk: 1, attempt: 1 },
    { type: 'prompt_prepared', runId: 'r1', stage: 'intent', prompt: { presetNote: null, system: 'SYS-1', user: 'USR-1', tools: [{ name: 'Write', description: '', schema: {} }], editedByOperator: false } },
    { type: 'assistant_text', runId: 'r1', stage: 'intent', text: 'первый' },
    { type: 'stage_done', runId: 'r1', stage: 'intent', ok: true, note: '' },
    { type: 'run_started', runId: 'r2', slug: 'ui-archive', profile: 'p', projectRoot: root },
    { type: 'prompt_prepared', runId: 'r2', stage: 'intent', prompt: { presetNote: null, system: 'ПРЕДПРОСМОТР', user: '', tools: [], editedByOperator: false } },
    { type: 'stage_started', runId: 'r2', stage: 'intent', flow: 'sdk', provider: 'claude', model: 'm2', chunk: 1, attempt: 1 },
    { type: 'prompt_prepared', runId: 'r2', stage: 'intent', prompt: { presetNote: null, system: 'SYS-2', user: 'USR-2', tools: [], editedByOperator: true } },
    { type: 'assistant_text', runId: 'r2', stage: 'intent', text: 'второй' },
    { type: 'assistant_text', runId: 'r2', stage: 'intent', text: 'и ещё' },
    { type: 'stage_done', runId: 'r2', stage: 'intent', ok: true, note: '' },
    { type: 'stage_started', runId: 'r2', stage: 'explore', flow: 'sdk', provider: 'claude', model: 'm2', chunk: 1, attempt: 1 },
    { type: 'stage_done', runId: 'r2', stage: 'explore', ok: false, note: 'артефакт этапа не заполнен' },
  ]),
);
writeArtifact(ui.metrics, JSON.stringify({ stages: [{ stage: 'intent', runs: 2, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 }, durationMs: 50 }], spent: { USD: 0.2 } }));

describe('scanWitoks', () => {
  it('два имени на один корень — один проект', () => {
    deepStrictEqual(project.aliases, ['demo', 'demo-alias']);
    strictEqual(projectByKey([project], 'demo-alias'), project);
  });

  it('источник: без ленты — терминал, с лентой — раннер', () => {
    const cards = scanWitoks(project, new Map());
    strictEqual(cards.find((c) => c.ref.slug === 'term')?.ref.source, 'terminal');
    strictEqual(cards.find((c) => c.ref.slug === 'ui-archive')?.ref.source, 'ui');
  });

  it('терминальный виток: chunk и попытка — из журналов, как у Run; чисел нет', () => {
    const c = witokCard(project, 'term', null)!;
    strictEqual(c.chunk, 2);
    strictEqual(c.attempt, 3);
    strictEqual(c.runCount, 0);
    strictEqual(c.usage, null);
    strictEqual(c.requirement, 'терминальная задача');
    const planOut = c.stages.find((s) => s.id === 'plan')?.outputs.find((o) => o.name === 'plan.md');
    deepStrictEqual(planOut?.decision, { label: 'Одобрение', state: 'pending' });
  });

  it('архив раннера: провал разведки из ленты, запуски и расход из чисел витка', () => {
    const c = witokCard(project, 'ui-archive', null)!;
    strictEqual(c.stages.find((s) => s.id === 'explore')?.state, 'failed');
    strictEqual(c.stages.find((s) => s.id === 'explore')?.note, 'артефакт этапа не заполнен');
    strictEqual(c.runCount, 2);
    strictEqual(c.usage?.costUsd, 0.2);
    strictEqual(c.currency, 'USD');
  });

  it('живой прогон: этап выполняется, статус «в работе», расход из памяти', () => {
    const live: RunSummary = {
      runId: 'live-1',
      slug: 'ui-archive',
      project: 'demo',
      profile: 'p',
      status: 'running',
      stage: 'explore',
      chunk: 1,
      attempt: 1,
      attemptBudget: 3,
      usage: { ...emptyUsage(), costUsd: 9 },
      waiting: 1,
      stageStartedAt: 1,
    };
    const c = witokCard(project, 'ui-archive', live)!;
    strictEqual(c.stages.find((s) => s.id === 'explore')?.state, 'running');
    strictEqual(c.status, 'open');
    strictEqual(c.usage?.costUsd, 9);
    strictEqual(c.live?.runId, 'live-1');
    // Живой виток без каталога тоже получает карточку.
    const fresh = scanWitoks(project, new Map([['not-yet', { ...live, slug: 'not-yet' }]]));
    ok(fresh.some((x) => x.ref.slug === 'not-yet'));
  });

  it('список: живой прогон подмешан в карточку своего витка; метка не зависит от часов', () => {
    const live: RunSummary = {
      runId: 'live-2',
      slug: 'term',
      project: 'demo',
      profile: 'p',
      status: 'awaiting',
      stage: null,
      chunk: 2,
      attempt: 3,
      attemptBudget: 3,
      usage: emptyUsage(),
      waiting: 2,
      stageStartedAt: null,
    };
    const r = dashboardList([project], [{ projectRoot: root, summary: live }], []);
    const term = r.cards.find((c) => c.ref.slug === 'term');
    strictEqual(term?.live?.runId, 'live-2');
    strictEqual(term.ref.source, 'ui');
    strictEqual(r.bench.available, false);
    const a = dashboardBody(r);
    const b = dashboardBody({ ...r, serverNow: r.serverNow + 1000 });
    strictEqual(a.etag, b.etag);
    deepStrictEqual(JSON.parse(a.body).cards, JSON.parse(JSON.stringify(r.cards)));
  });

  it('источник: каталог .runner/ без прогонов этапов — всё ещё терминал', () => {
    const p = new WitokPaths(root, 'term-opened');
    writeArtifact(p.intent, '# Задача: открыт в интерфейсе, ведётся в терминале\n');
    // Так выглядит терминальный виток, который однажды открыли в интерфейсе: конструктор
    // `Run` пишет `.runner/.gitignore` и `run_started`, но этапов раннер не запускал.
    writeArtifact(join(p.runnerDir, '.gitignore'), '*\n');
    writeArtifact(p.events, events([{ type: 'run_started', runId: 'r', slug: 'term-opened', profile: 'p', projectRoot: root }]));
    strictEqual(witokCard(project, 'term-opened', null)?.ref.source, 'terminal');
  });

  it('задача с законно пустой секцией «Что придётся тронуть» — пройдена, а не провалена', () => {
    const p = new WitokPaths(root, 'touch-empty');
    writeArtifact(
      p.intent,
      '# Задача: сделать\n\n**Контур:** полный\n\n## Что придётся тронуть\n\n- ‹заполнит разведка›\n',
    );
    const intent = witokCard(project, 'touch-empty', null)?.stages.find((s) => s.id === 'intent');
    ok(intent?.state !== 'failed', `intent: ${intent?.state} ${intent?.note}`);
    strictEqual(intent?.outputs.find((o) => o.name === 'intent.md')?.placeholders, 0);
  });
});

describe('детали витка', () => {
  it('последний прогон этапа — от последнего stage_started; предпросмотр оператора не в счёт', () => {
    const d = dashboardDetail('ui', 'demo', 'ui-archive', [project], [], []);
    ok('ok' in d);
    const intent = d.ok.stages.find((s) => s.id === 'intent')!;
    strictEqual(intent.lastRun?.runId, 'r2');
    strictEqual(intent.lastRun?.prompt?.system, 'SYS-2');
    strictEqual(intent.lastRun?.prompt?.editedByOperator, true);
    strictEqual(intent.lastRun?.assistantText, 'второй\n\nи ещё');
    strictEqual(intent.metrics?.runs, 2);
    deepStrictEqual(d.ok.runIds, ['r1', 'r2']);
  });

  it('входы этапа — со статусом и обязательностью', () => {
    const d = dashboardDetail('terminal', 'demo', 'term', [project], [], []);
    ok('ok' in d);
    const plan = d.ok.stages.find((s) => s.id === 'plan')!;
    deepStrictEqual(
      plan.inputs.map((i) => [i.name, i.optional, i.presence]),
      [
        ['intent.md', false, 'filled'],
        ['readiness.md', false, 'missing'],
        ['exploration-report.md', true, 'missing'],
        ['clarification-report.md', true, 'missing'],
      ],
    );
    // Терминальный виток: ленты нет — прогона нет; вердикта рантайма на машине нет.
    strictEqual(plan.lastRun, null);
    strictEqual(d.ok.stages.find((s) => s.id === 'verify')?.storedVerdict, null);
  });

  it('вердикт рантайма этой машины виден на verify и handoff', () => {
    writeRunVerdict(term, 2, 3, { passed: true, action: 'continue', reasons: [] });
    const d = dashboardDetail('terminal', 'demo', 'term', [project], [], []);
    ok('ok' in d);
    strictEqual(d.ok.stages.find((s) => s.id === 'verify')?.storedVerdict?.passed, true);
    strictEqual(d.ok.stages.find((s) => s.id === 'plan')?.storedVerdict, null);
  });

  it('несуществующий виток и чужой проект — 404, источник вне словаря — 400', () => {
    const a = dashboardDetail('ui', 'demo', 'нет-такого', [project], [], []);
    ok('error' in a && a.code === 404);
    const b = dashboardDetail('ui', 'other', 'term', [project], [], []);
    ok('error' in b && b.code === 404);
    const c = dashboardDetail('cli', 'demo', 'term', [project], [], []);
    ok('error' in c && c.code === 400);
  });
});

describe('содержимое файлов — по имени из словаря', () => {
  it('словарь имён', () => {
    for (const n of ['plan.md', 'chunk-1-attempt-2-diff.patch', '.runner/iterations.md', 'gates.md', '.intent-sections.json']) {
      ok(allowedWitokName(n), `${n} должен быть разрешён`);
    }
    for (const n of ['../x', '..\\x', 'C:\\x', '/etc/passwd', 'src/a.ts', '.events.ndjson', '.chunk-1-baseline.json', 'mcp/shot.png', 'PLAN.md', '.runner/../plan.md']) {
      ok(!allowedWitokName(n), `${n} должен быть отклонён`);
    }
  });

  it('читает файл витка и считает плейсхолдеры', () => {
    const r = dashboardArtifact('terminal', 'demo', 'term', 'plan.md', [project], []);
    ok('ok' in r);
    strictEqual(r.ok.placeholders, 1);
    strictEqual(r.ok.truncated, false);
    const miss = dashboardArtifact('terminal', 'demo', 'term', 'handoff.md', [project], []);
    ok('error' in miss && miss.code === 404);
  });

  it('symlink из каталога витка наружу отклоняется', (t) => {
    writeFileSync(join(root, 'secret.txt'), 'секрет');
    try {
      symlinkSync(join(root, 'secret.txt'), join(term.dir, 'readiness.md'));
    } catch {
      t.skip('symlink недоступен на этой машине');
      return;
    }
    const r = resolveWitokArtifact(term, 'readiness.md');
    ok('error' in r && r.code === 400);
  });

  it('slug адреса без разделителей пути', () => {
    ok(badWitokSlug('../x') !== null);
    ok(badWitokSlug('a/b') !== null);
    ok(badWitokSlug('a\\b') !== null);
    strictEqual(badWitokSlug('FIX-UI-018'), null);
  });
});

describe('indexEvents', () => {
  it('этап, начатый и не закрытый к концу ленты, — оборван', () => {
    const idx = indexEvents([
      { type: 'stage_started', runId: 'r', stage: 'plan', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
    ]);
    strictEqual(idx.failed.get('plan'), 'прогон оборван: этап начат, но не закрыт');
    ok(idx.open.has('plan'));
  });

  it('пропуск без stage_started оставляет причину; отказ до старта — ошибкой', () => {
    const idx = indexEvents([
      { type: 'stage_done', runId: 'r', stage: 'ask', ok: true, note: 'вопросов нет' },
      { type: 'error', runId: 'r', stage: 'chunk', message: 'нет плана' },
    ]);
    deepStrictEqual(idx.stages.get('ask')?.outcome, { ok: true, note: 'вопросов нет' });
    deepStrictEqual(idx.stages.get('chunk')?.errors, ['не стартовал: нет плана']);
  });

  it('отказ повторного входа не стирает прошлый прогон этапа', () => {
    const idx = indexEvents([
      { type: 'stage_started', runId: 'r', stage: 'handoff', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
      { type: 'assistant_text', runId: 'r', stage: 'handoff', text: 'передано' },
      { type: 'stage_done', runId: 'r', stage: 'handoff', ok: true, note: '' },
      { type: 'error', runId: 'r', stage: 'handoff', message: 'нет вердикта' },
    ]);
    strictEqual(idx.stages.get('handoff')?.assistantText, 'передано');
    deepStrictEqual(idx.stages.get('handoff')?.errors, ['не стартовал: нет вердикта']);
    strictEqual(idx.failed.has('handoff'), false);
  });

  it('этап, упавший исключением (error без stage_done), — провален с текстом ошибки', () => {
    const idx = indexEvents([
      { type: 'stage_started', runId: 'r', stage: 'plan', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
      { type: 'error', runId: 'r', stage: 'plan', message: 'провайдер: 500' },
    ]);
    strictEqual(idx.failed.get('plan'), 'этап упал: провайдер: 500');
    strictEqual(idx.openErrors.get('plan'), 'провайдер: 500');
  });

  it('у живого витка упавший этап — провален, а не «не начат»', () => {
    const p = new WitokPaths(root, 'crashed');
    writeArtifact(p.intent, '# Задача: упадёт\n');
    writeArtifact(
      p.events,
      events([
        { type: 'run_started', runId: 'r', slug: 'crashed', profile: 'p', projectRoot: root },
        { type: 'stage_started', runId: 'r', stage: 'explore', flow: 'loop', provider: 'x', model: 'y', chunk: 1, attempt: 1 },
        { type: 'error', runId: 'r', stage: 'explore', message: 'провайдер: 500' },
      ]),
    );
    const live: RunSummary = {
      runId: 'r',
      slug: 'crashed',
      project: 'demo',
      profile: 'p',
      status: 'failed',
      stage: null,
      chunk: 1,
      attempt: 1,
      attemptBudget: 3,
      usage: emptyUsage(),
      waiting: 0,
      stageStartedAt: null,
    };
    const explore = witokCard(project, 'crashed', live)?.stages.find((s) => s.id === 'explore');
    strictEqual(explore?.state, 'failed');
    strictEqual(explore?.note, 'этап упал: провайдер: 500');
  });
});
