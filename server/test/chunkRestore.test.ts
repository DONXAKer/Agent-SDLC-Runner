/**
 * Восстановление chunk/attempt из артефактов на диске при создании `Run` (A8 ретроспективы
 * AUTH-104).
 *
 * Наблюдение живого витка: рестарт процесса Runner'а откатывал `chunk`/`attempt` в памяти
 * на 1/1, хотя виток на диске стоял на chunk 3 — единственным обходом было вручную
 * «прокликать» попытки кнопками, рискуя случайно перезапустить дорогой этап.
 * `restoreAttemptFromJournal` внутри chunk'а уже существовала; здесь — недостающая половина,
 * восстановление самого номера chunk'а.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';
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

function route(stage: StageId, modelId: string): ResolvedRoute {
  return {
    stage,
    provider: 'p',
    providerDef: { flow: 'loop', kind: 'openai-compat' },
    model: modelId,
    modelId,
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
  };
}

function profile(): ResolvedProfile {
  const routes = Object.fromEntries(STAGE_ORDER.map((s) => [s, route(s, 'm')])) as Record<
    StageId,
    ResolvedRoute
  >;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<
    StageId,
    ResolvedRoute[]
  >;
  return { name: 'demo', label: 'demo', routes, ensemble };
}

function makeRun(root: string): Run {
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
        readRangeRequiredAboveBytes: 1000,
        maxIterationsPerStage: 4,
        gateTimeoutMs: 1000,
        progressClosenessWarn: 0.9,
        chatTimeoutMs: 1000,
      },
    },
    models: { models: [] },
    projects: new Map(),
    mcp: new Map(),
  } as unknown as LoadedConfig;

  return new Run({
    config,
    project,
    profile: profile(),
    slug: 'demo',
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: () => {},
  });
}

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-chunkrestore-')));
  roots.push(root);
  return root;
}

const JOURNAL = (k: number): string =>
  [
    '# Журнал chunk',
    '',
    '## Попытки',
    '| K | Дата | Что чинили | Что изменилось | Итог |',
    '|---|---|---|---|---|',
    ...Array.from({ length: k }, (_, i) => `| ${i + 1} | 2026-08-23 | х | х | х |`),
  ].join('\n');

describe('восстановление chunk/attempt из артефактов на диске', () => {
  it('свежий виток без единого журнала — chunk 1, attempt 1, как раньше', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    const run = makeRun(root);
    strictEqual(run.chunk, 1);
    strictEqual(run.attempt, 1);
  });

  it('на диске лежат журналы chunk 1..3 — восстанавливается chunk 3', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'chunk-2-journal.md'), JOURNAL(1));
    writeFileSync(join(dir, 'chunk-3-journal.md'), JOURNAL(2));
    const run = makeRun(root);
    strictEqual(run.chunk, 3, 'номер chunk должен восстановиться по журналам на диске');
    strictEqual(run.attempt, 2, 'внутри восстановленного chunk обязана восстановиться и попытка');
  });

  it('журналы не по порядку в каталоге — берётся МАКСИМАЛЬНЫЙ номер, а не последний созданный', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-5-journal.md'), JOURNAL(1));
    writeFileSync(join(dir, 'chunk-2-journal.md'), JOURNAL(3));
    const run = makeRun(root);
    strictEqual(run.chunk, 5);
  });

  it('посторонний файл с похожим именем не считается журналом chunk\'а', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(1));
    // Похоже на журнал попытки/патч, но не журнал chunk'а — не должно перебивать восстановление.
    writeFileSync(join(dir, 'chunk-9-attempt-1-diff.patch'), 'diff --git a b');
    const run = makeRun(root);
    strictEqual(run.chunk, 1);
  });

  // Живой виток ta-13: журнал хранит K последней НАЧАТОЙ попытки; свежий прогон
  // восстановил K=2, хотя вердикт по попытке 2 уже был записан, и перезаписал её улики
  // уликами следующей попытки. Записанный вердикт = попытка закончена, номер идёт дальше.
  it('вердикт по восстановленной попытке уже записан — попытка сдвигается на следующую', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'verification-report-1-attempt-1.md'), 'passed: false');
    writeFileSync(join(dir, 'verification-report-1-attempt-2.md'), 'passed: false');
    const run = makeRun(root);
    strictEqual(run.attempt, 3, 'отревьюенная попытка закончена — свежий прогон продолжает следующей');
  });

  it('журнал есть, вердикта по последней попытке нет — номер не сдвигается (попытка продолжается)', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'verification-report-1-attempt-1.md'), 'passed: false');
    const run = makeRun(root);
    strictEqual(run.attempt, 2, 'незавершённая попытка продолжается под своим номером');
  });

  // Зелёная попытка и бланк без вердикта номер не сдвигают: зелёный виток после рестарта
  // обязан дойти до handoff по СВОЕМУ отчёту (code-review-all 2026-09-23).
  it('зелёный вердикт по попытке — номер не сдвигается, handoff найдёт свой отчёт', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'verification-report-1-attempt-1.md'), 'passed: false');
    writeFileSync(join(dir, 'verification-report-1-attempt-2.md'), '## Вердикт\n\n- **passed:** true\n');
    strictEqual(makeRun(root).attempt, 2);
  });

  it('бланк отчёта без вердикта (`true / false`) — verify прерван до вердикта, попытка та же', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'verification-report-1-attempt-1.md'), 'passed: false');
    writeFileSync(join(dir, 'verification-report-1-attempt-2.md'), '## Вердикт\n\n- **passed:** true / false\n');
    strictEqual(makeRun(root).attempt, 2);
  });

  it('каталога витка ещё нет вовсе — восстанавливать нечего, chunk 1', () => {
    const root = tempRoot();
    const run = makeRun(root);
    strictEqual(run.chunk, 1);
    strictEqual(run.attempt, 1);
    ok(true);
  });
});

describe('advanceProblem: продвижение витка по вердикту на диске (code-review-all 2026-09-23)', () => {
  function withReport(verdict: string | null): ReturnType<typeof makeRun> {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(1));
    // Отчёт пишется ПОСЛЕ создания Run — как вердикт живого витка. Созданный поверх
    // красного отчёта Run уже стоит на следующей попытке (восстановление после рестарта).
    const run = makeRun(root);
    if (verdict !== null) writeFileSync(join(dir, 'verification-report-1-attempt-1.md'), verdict);
    return run;
  }

  it('непроверенная попытка — ни новой попытки, ни следующего chunk', () => {
    const run = withReport(null);
    ok(run.advanceProblem('attempt') !== null);
    ok(run.advanceProblem('chunk') !== null);
  });

  it('красный retry — новая попытка можно, следующий chunk нельзя', () => {
    const run = withReport('## Вердикт\n\n- **passed:** false\n- **action:** retry\n');
    strictEqual(run.advanceProblem('attempt'), null);
    ok(run.advanceProblem('chunk') !== null);
  });

  it('escalate — новая попытка закрыта: решение за человеком', () => {
    const run = withReport('## Вердикт\n\n- **passed:** false\n- **action:** escalate\n');
    ok(run.advanceProblem('attempt')?.includes('escalate'));
  });

  it('зелёная попытка — следующий chunk можно, новая попытка не нужна', () => {
    const run = withReport('## Вердикт\n\n- **passed:** true\n- **action:** continue\n');
    strictEqual(run.advanceProblem('chunk'), null);
    ok(run.advanceProblem('attempt') !== null);
  });

  it('двойной клик: после новой попытки вторая уже не проходит', () => {
    const run = withReport('## Вердикт\n\n- **passed:** false\n- **action:** retry\n');
    strictEqual(run.advanceProblem('attempt'), null);
    run.nextAttempt();
    ok(run.advanceProblem('attempt') !== null, 'попытка 2 ещё не проверена');
  });
});
