/**
 * Накопление метрик витка: гейт-агрегаты, трение о человека, плейсхолдер-греп,
 * восстановление из `metrics.json` и сквозная запись файлов после этапа.
 *
 * Фабрика `Run` — по образцу `chunkRestore.test.ts`: виток строится на tmpdir, события
 * уходят в переданный sink. Сквозной прогон `runStage('intent')` идёт через подменный
 * OpenAI-совместимый сервер (модель отвечает текстом без вызовов инструментов) — роняем
 * этап на незаполненном артефакте намеренно: снапшот метрик обязан записаться в `finally`
 * независимо от исхода этапа.
 */

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { GateRunResult, Question, RunEvent, RunMetrics, StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { Run } from '../src/run/Run.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-metrics-')));
  roots.push(root);
  return root;
}

function route(stage: StageId, over: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    stage,
    provider: 'stub',
    providerDef: { flow: 'loop', kind: 'openai-compat' },
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
    stepFill: false,
    compactForms: 'off',
    ...over,
  };
}

function profile(over: Partial<ResolvedRoute> = {}): ResolvedProfile {
  const routes = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, route(s, over)]),
  ) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<
    StageId,
    ResolvedRoute[]
  >;
  return { name: 'demo', label: 'demo', routes, ensemble };
}

function makeRun(root: string, events: RunEvent[] = [], over: Partial<ResolvedRoute> = {}): Run {
  const project: ProjectConfig = {
    name: 'demo',
    projectRoot: root,
    activeProfile: 'demo',
    maxBudgetUsd: 1,
    profiles: {},
  };
  const config = {
    runner: {
      port: 0,
      operator: 'Гриц',
      skillsDir: join(root, 'skills'),
      agentsDir: join(root, 'agents'),
      methodologyDir: join(root, 'methodology'),
      limits: {
        maxToolResultBytes: 1000,
        localMaxToolResultBytes: 1000,
        readRangeRequiredAboveBytes: 1000,
        maxIterationsPerStage: 4,
        gateTimeoutMs: 1000,
        progressClosenessWarn: 0.9,
        chatTimeoutMs: 5000,
      },
    },
    models: { models: [] },
    projects: new Map(),
    mcp: new Map(),
  } as unknown as LoadedConfig;

  return new Run({
    config,
    project,
    profile: profile(over),
    slug: 'demo',
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: (e) => events.push(e),
  });
}

function gate(name: string, status: GateRunResult['status'], durationMs: number): GateRunResult {
  return { name, status, command: null, exitCode: null, lastLine: '', durationMs, envBlocked: false };
}

/** Минимальный набор гейтов: «Сборка» включена, «Тесты» выключена долгом. */
const GATES_MD = [
  '# Набор гейтов',
  '',
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да — минимум | этап 6 | `npm run build` |',
  '| Тесты | нет — долг | этап 6 | `npm test` |',
  '',
].join('\n');

describe('гейт-агрегаты витка', () => {
  it('сворачиваются по имени гейта: прогоны, красные, ⏭ у включённого, время', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'gates.md'), GATES_MD);
    const run = makeRun(root);

    run.recordGateResult(gate('Сборка', '✅', 100));
    run.recordGateResult(gate('Сборка', '❌', 200));
    run.recordGateResult(gate('Сборка', '⏭', 50));
    run.recordGateResult(gate('Тесты', '⏭', 10));

    deepStrictEqual(run.metrics.gates, [
      { gate: 'Сборка', runs: 3, red: 1, skippedWhileEnabled: 1, durationMs: 350 },
      // ⏭ выключенного гейта не считается «пропуском включённого».
      { gate: 'Тесты', runs: 1, red: 0, skippedWhileEnabled: 0, durationMs: 10 },
    ]);
  });

  it('⏭ без подтверждённой строки в наборе в «пропуск включённого» не идёт, прогон — идёт', () => {
    const root = tempRoot();
    const run = makeRun(root);
    run.recordGateResult(gate('Сборка', '⏭', 10));

    deepStrictEqual(run.metrics.gates, [
      { gate: 'Сборка', runs: 1, red: 0, skippedWhileEnabled: 0, durationMs: 10 },
    ]);
  });
});

describe('трение о человека', () => {
  it('копится по этапам: вопросы, одобрения, суммарное ожидание', () => {
    const root = tempRoot();
    const run = makeRun(root);

    run.recordHuman('chunk', 'approval', 1, 1500);
    run.recordHuman('chunk', 'approval', 0, 500); // отказ оператора — ожидание есть, одобрения нет
    run.recordHuman('chunk', 'question', 2, 3000);
    run.recordHuman('plan', 'question', 1, 700);

    deepStrictEqual(run.metrics.human, [
      { stage: 'chunk', questions: 2, approvals: 1, waitMs: 5000 },
      { stage: 'plan', questions: 1, approvals: 0, waitMs: 700 },
    ]);
  });

  it('снятые отменой одобрения в ожидание не идут', () => {
    const root = tempRoot();
    const run = makeRun(root);

    // Решение оператора — считается.
    run.noteApprovalDecision(
      { runId: run.id, stage: 'chunk', createdAt: Date.now() - 1000, cancelled: false },
      { allowed: true, updatedInput: null, by: 'operator' },
    );
    // Автоодобрение и отказ политики человека не ждали.
    run.noteApprovalDecision(
      { runId: run.id, stage: 'chunk', createdAt: Date.now() - 5000, cancelled: false },
      { allowed: true, updatedInput: null, by: 'auto' },
    );
    // Снятый обрывом прогона запрос: `cancelRun` резолвит его `by: 'operator'`, и без
    // признака отмены всё время висения уезжало в «этап ждал человека» (ревью).
    run.noteApprovalDecision(
      { runId: run.id, stage: 'chunk', createdAt: Date.now() - 1_200_000, cancelled: true },
      { allowed: false, reason: 'этап оборван', by: 'operator' },
    );

    const chunk = run.metrics.human.find((h) => h.stage === 'chunk');
    strictEqual(chunk?.approvals, 1);
    ok((chunk?.waitMs ?? 0) < 60_000, `ожидание не должно включать снятые запросы: ${chunk?.waitMs}`);
  });

  it('AskGate отдаёт в колбэк момент вопроса, число вопросов и признак отмены', () => {
    // Метрике важна только длина списка вопросов, но тип контракта общий — форма полная.
    const q = (id: string, question: string): Question => ({
      id,
      question,
      header: 'Х',
      multiSelect: false,
      options: [],
    });
    const seen: { createdAt: number; questions: number; cancelled: boolean }[] = [];
    const g = new AskGate({
      onPending: () => {},
      onAnswered: (info) =>
        seen.push({ createdAt: info.createdAt, questions: info.questions, cancelled: info.cancelled }),
    });

    const p = g.ask({ runId: 'r', stage: 'plan', questions: [q('q1', 'а?'), q('q2', 'б?')] });
    g.answer('r', 'ask-r-1', { 'а?': ['да'] });
    void g.ask({ runId: 'r', stage: 'chunk', questions: [q('q3', 'в?')] });
    g.cancelRun('r');
    void p;

    strictEqual(seen.length, 2);
    ok(seen[0]!.createdAt > 0);
    strictEqual(seen[0]!.questions, 2);
    strictEqual(seen[0]!.cancelled, false);
    strictEqual(seen[1]!.questions, 1);
    strictEqual(seen[1]!.cancelled, true, 'снятый отменой вопрос — не ответ человека');
  });
});

describe('плейсхолдер-греп артефактов', () => {
  it('последний счётчик на артефакт; дозаполнение до нуля стирает строку', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), '# План\n\n‹шаг›\n‹срок›\n');
    const run = makeRun(root);

    // Тот же счётчик, что событие `artifact_written` несёт из readArtifact.
    run.noteArtifactGap(join(root, '.sdlc', 'demo', 'plan.md'), 2);
    deepStrictEqual(run.metrics.artifactGaps, [{ artifact: 'plan.md', placeholders: 2 }]);

    // Решение человека пишется через recordDecision → artifact_written(placeholders: 0)
    // через перехват в обёртке emit — строка из долга исчезает.
    run.noteArtifactGap(join(root, '.sdlc', 'demo', 'plan.md'), 0);
    deepStrictEqual(run.metrics.artifactGaps, []);
  });
});

describe('восстановление метрик из metrics.json', () => {
  it('пересозданный Run подхватывает накопители, как chunk/attempt из журналов', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    const snapshot: RunMetrics = {
      stages: [{ stage: 'chunk', runs: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 0 }, durationMs: 3000 }],
      verdicts: { total: 2, red: 1 },
      redByCause: [{ kind: 'gate', count: 1 }],
      attemptsByChunk: [{ chunk: 1, attempts: 2 }],
      friction: [{ stage: 'chunk', repeat: 1, badJson: 0, denied: 0, truncated: 0, toolCalls: 7, reminders: 2 }],
      gates: [{ gate: 'Сборка', runs: 2, red: 1, skippedWhileEnabled: 0, durationMs: 900 }],
      human: [{ stage: 'chunk', questions: 1, approvals: 3, waitMs: 4000 }],
      artifactGaps: [{ artifact: 'plan.md', placeholders: 1 }],
    };
    writeFileSync(join(root, '.sdlc', 'demo', 'metrics.json'), JSON.stringify(snapshot));

    const run = makeRun(root);
    // Накопление продолжается, а не начинается с нуля: +1 прогон гейта поверх восстановленных двух.
    run.recordGateResult(gate('Сборка', '✅', 100));

    strictEqual(run.metrics.verdicts.total, 2);
    strictEqual(run.metrics.stages.find((s) => s.stage === 'chunk')?.runs, 2);
    strictEqual(run.metrics.gates[0]?.runs, 3);
    strictEqual(run.metrics.human[0]?.approvals, 3);
    deepStrictEqual(run.metrics.artifactGaps, [{ artifact: 'plan.md', placeholders: 1 }]);
  });

  it('старый снапшот без новых полей — пустые массивы, без исключения', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    const legacy = {
      stages: [],
      verdicts: { total: 1, red: 0 },
      redByCause: [],
      attemptsByChunk: [],
      friction: [],
    };
    writeFileSync(join(root, '.sdlc', 'demo', 'metrics.json'), JSON.stringify(legacy));

    const run = makeRun(root);
    strictEqual(run.metrics.verdicts.total, 1);
    // Проверка содержательна только вместе с накоплением ПОВЕРХ восстановленного: у
    // свежего витка эти массивы пусты и без единой строки восстановления, поэтому голое
    // «пусто» здесь ловило бы удаление кода восстановления как «всё в порядке» (ревью).
    run.recordHuman('plan', 'approval', 1, 100);
    deepStrictEqual(run.metrics.human, [{ stage: 'plan', questions: 0, approvals: 1, waitMs: 100 }]);
    deepStrictEqual(run.metrics.gates, []);
    deepStrictEqual(run.metrics.artifactGaps, []);
  });

  it('снапшот с мусором в полях не ломает старт и не приносит мусорных строк', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', 'metrics.json'),
      JSON.stringify({
        stages: 'строка вместо массива',
        verdicts: { total: 'два', red: null },
        gates: [{ gate: 42 }, { gate: 'Сборка', runs: NaN, durationMs: 'долго' }],
        human: [{ stage: 5, questions: 1 }],
        artifactGaps: [{ artifact: 'plan.md', placeholders: 'много' }],
        spent: { USD: 'дорого', RUB: 120 },
      }),
    );

    const run = makeRun(root);
    deepStrictEqual(run.metrics.stages, []);
    strictEqual(run.metrics.verdicts.total, 0);
    deepStrictEqual(run.metrics.gates, [
      { gate: 'Сборка', runs: 0, red: 0, skippedWhileEnabled: 0, durationMs: 0 },
    ]);
    deepStrictEqual(run.metrics.human, []);
    deepStrictEqual(run.metrics.artifactGaps, []);
  });

  it('расход и суммы по валютам восстанавливаются вместе с этапами', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', 'metrics.json'),
      JSON.stringify({
        stages: [
          {
            stage: 'chunk',
            runs: 1,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 4, durationMs: 0 },
            durationMs: 1000,
          },
        ],
        verdicts: { total: 1, red: 1 },
        redByCause: [],
        attemptsByChunk: [],
        friction: [],
        gates: [],
        human: [],
        artifactGaps: [],
        spent: { USD: 4 },
      }),
    );

    // Пока расход не восстанавливался, шапка показывала $0 над вкладкой «Метрики» с $4,
    // а бюджетный гард стартовал с нуля и разрешал потратить потолок заново (ревью).
    const run = makeRun(root);
    strictEqual(run.totalUsage.costUsd, 4);
    strictEqual(run.totalUsage.inputTokens, 10);
  });

  it('битый снапшот не ломает старт витка', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'demo', 'metrics.json'), 'не json вовсе');
    const run = makeRun(root);
    strictEqual(run.metrics.verdicts.total, 0);
  });
});

/**
 * Общая обвязка сквозного кейса: текст этапа, форма артефакта и подменный
 * OpenAI-совместимый сервер, отвечающий текстом без вызовов инструментов.
 */
async function runIntentWithStub(root: string, events: RunEvent[]): Promise<{ ok: boolean }> {
  mkdirSync(join(root, 'skills', 'sdlc-intent'), { recursive: true });
  writeFileSync(join(root, 'skills', 'sdlc-intent', 'SKILL.md'), 'Заполни intent.md по форме.');
  mkdirSync(join(root, 'methodology', 'templates'), { recursive: true });
  writeFileSync(
    join(root, 'methodology', 'templates', 'intent.template.md'),
    '# Цель\n\n| Поле | Значение |\n|---|---|\n| Задача | ‹текст задачи› |\n',
  );

  const stub = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'готово' }, finish_reason: 'stop' }],
        }),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;
  try {
    const run = makeRun(root, events, {
      providerDef: { flow: 'loop', kind: 'openai-compat', baseUrl: `http://127.0.0.1:${port}` },
    });
    const outcome = await run.runStage('intent');
    return { ok: outcome.ok };
  } finally {
    stub.close();
  }
}

describe('запись снапшота метрик не роняет этап', () => {
  it('ошибка записи уходит предупреждением, а не исключением из finally', async () => {
    const root = tempRoot();
    // `metrics.json` — каталог: запись обязана упасть, но исход этапа считает этап, а не
    // наблюдаемость. Ревью: `catch` в `writeMetricsSnapshot` не был покрыт ничем.
    mkdirSync(join(root, '.sdlc', 'demo', 'metrics.json'), { recursive: true });

    const events: RunEvent[] = [];
    const outcome = await runIntentWithStub(root, events);

    // Этап честно красный по своей причине (бланк не заполнен), а не из-за метрик.
    strictEqual(outcome.ok, false);
    const warned = events.some((e) => e.type === 'warning' && /метрики витка не записаны/.test(e.message));
    ok(warned, 'ошибка записи метрик обязана быть названа предупреждением');
  });
});

describe('сквозной: runStage пишет metrics.json и metrics.md', () => {
  it('снапшот на диске после этапа, независимо от исхода этапа', async () => {
    const root = tempRoot();
    // Текст этапа для сборки промпта — рантайм читает его с диска, копий в коде нет.
    mkdirSync(join(root, 'skills', 'sdlc-intent'), { recursive: true });
    writeFileSync(join(root, 'skills', 'sdlc-intent', 'SKILL.md'), 'Заполни intent.md по форме.');
    // Форма с плейсхолдером: этап её не заполнит (модель-заглушка пишет текстом), и
    // артефакт должен остаться в таблице незакрытых мест.
    mkdirSync(join(root, 'methodology', 'templates'), { recursive: true });
    writeFileSync(
      join(root, 'methodology', 'templates', 'intent.template.md'),
      '# Цель\n\n| Поле | Значение |\n|---|---|\n| Задача | ‹текст задачи› |\n',
    );

    // Подменный OpenAI-совместимый сервер: отвечает текстом без вызовов инструментов.
    const stub = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: 'assistant', content: 'готово' }, finish_reason: 'stop' },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as AddressInfo).port;

    try {
      const events: RunEvent[] = [];
      const run = makeRun(root, events, {
        providerDef: { flow: 'loop', kind: 'openai-compat', baseUrl: `http://127.0.0.1:${port}` },
      });

      const outcome = await run.runStage('intent');
      // Модель-заглушка не заполнила бланк — этап честно падает; это ожидаемо.
      strictEqual(outcome.ok, false);

      const dir = join(root, '.sdlc', 'demo');
      const jsonPath = join(dir, 'metrics.json');
      const mdPath = join(dir, 'metrics.md');
      ok(existsSync(jsonPath), 'metrics.json записан в finally этапа');
      ok(existsSync(mdPath), 'metrics.md записан вместе со снапшотом');

      const snapshot = JSON.parse(readFileSync(jsonPath, 'utf8')) as RunMetrics;
      strictEqual(snapshot.stages[0]?.stage, 'intent');
      strictEqual(snapshot.stages[0]?.runs, 1);
      // Форма разложена с ‹…› и не заполнена — артефакт обязан быть в долге.
      deepStrictEqual(snapshot.artifactGaps, [{ artifact: 'intent.md', placeholders: 1 }]);

      const md = readFileSync(mdPath, 'utf8');
      match(md, /## Метрики витка \(посчитано рантаймом\)/);
      match(md, /\| intent\.md \| 1 \|/);

      // Служебные файлы рантайма не эмитятся как артефакты этапа.
      strictEqual(
        events.some((e) => e.type === 'artifact_written' && e.path.endsWith('metrics.md')),
        false,
      );
    } finally {
      stub.close();
    }
  });
});
