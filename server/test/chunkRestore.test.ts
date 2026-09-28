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
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { StageId, Verdict, VerdictAction } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { Run } from '../src/run/Run.ts';
import { writeRunVerdict } from '../src/run/verdictStore.ts';

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
    stepContext: false,
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

  // Журнал хранит K последней НАЧАТОЙ попытки, и виток остаётся на ней при любом вердикте:
  // сдвиг за красной попыткой при восстановлении обходил `/advance` — «попытка 4 из 3»
  // после escalate, попытка без патча после blocked_env (code-review-all 2026-09-23).
  // Улики отвергнутой попытки (ta-13) бережёт предусловие chunk (`verdictOnDisk.test.ts`).
  const verdictFile = (dir: string, attempt: number, passed: boolean, action: string): void =>
    writeRunVerdict(new WitokPaths(dirname(dirname(dir)), 'demo'), 1, attempt, { passed, action: action as VerdictAction, reasons: [] });

  it('красный вердикт по восстановленной попытке — номер не сдвигается, вердикт восстановлен', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    verdictFile(dir, 1, false, 'retry');
    verdictFile(dir, 2, false, 'escalate');
    const run = makeRun(root);
    strictEqual(run.attempt, 2);
    strictEqual(run.lastVerdict?.action, 'escalate');
    ok(run.advanceProblem('attempt')?.includes('escalate'), 'escalate после рестарта не обходится');
  });

  it('`passed: false` в отчёте без вердикта рантайма — не вердикт: попытка та же, advance закрыт', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    writeFileSync(join(dir, 'verification-report-1-attempt-2.md'), '## Вердикт\n\n- **passed:** false\n');
    const run = makeRun(root);
    strictEqual(run.attempt, 2);
    strictEqual(run.lastVerdict, null);
    ok(run.advanceProblem('attempt') !== null);
  });

  it('зелёный вердикт по попытке — номер не сдвигается, следующий chunk открыт', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    verdictFile(dir, 1, false, 'retry');
    verdictFile(dir, 2, true, 'continue');
    const run = makeRun(root);
    strictEqual(run.attempt, 2);
    strictEqual(run.advanceProblem('chunk'), null);
  });

  it('blocked_env не занимает номер: «Новая попытка» после него — та же K', () => {
    // `SDLC.md` → «blocked_env в этот счёт не входит»: следующий прогон после закрытия
    // долга среды — та же попытка K, не K+1; chunk по ней открыт, а не «уже отвергнута».
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    verdictFile(dir, 1, false, 'retry');
    verdictFile(dir, 2, false, 'blocked_env');
    const run = makeRun(root);
    strictEqual(run.attempt, 2);
    strictEqual(run.advanceProblem('attempt'), null);
    strictEqual(run.nextAttempt(), 2);
    strictEqual(run.blockers('chunk').filter((p) => p.includes('отвергнута')).length, 0);
  });

  it('обычный красный по-прежнему сдвигает номер', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk-1-journal.md'), JOURNAL(2));
    verdictFile(dir, 2, false, 'retry');
    const run = makeRun(root);
    strictEqual(run.nextAttempt(), 3);
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
    // Вердикт пишется ПОСЛЕ создания Run — как вердикт живого витка (служебный файл
    // попытки, `verdictStore.ts`; строке отчёта рантайм не доверяет).
    const run = makeRun(root);
    if (verdict !== null) writeRunVerdict(new WitokPaths(root, 'demo'), 1, 1, JSON.parse(verdict) as Verdict);
    return run;
  }
  const v = (passed: boolean, action: string): string => JSON.stringify({ passed, action, reasons: [] });

  it('непроверенная попытка — ни новой попытки, ни следующего chunk', () => {
    const run = withReport(null);
    ok(run.advanceProblem('attempt') !== null);
    ok(run.advanceProblem('chunk') !== null);
  });

  it('красный retry — новая попытка можно, следующий chunk нельзя', () => {
    const run = withReport(v(false, 'retry'));
    strictEqual(run.advanceProblem('attempt'), null);
    ok(run.advanceProblem('chunk') !== null);
  });

  it('escalate — новая попытка закрыта: решение за человеком', () => {
    const run = withReport(v(false, 'escalate'));
    ok(run.advanceProblem('attempt')?.includes('escalate'));
  });

  it('зелёная попытка — следующий chunk можно, новая попытка не нужна', () => {
    const run = withReport(v(true, 'continue'));
    strictEqual(run.advanceProblem('chunk'), null);
    ok(run.advanceProblem('attempt') !== null);
  });

  it('двойной клик: после новой попытки вторая уже не проходит', () => {
    const run = withReport(v(false, 'retry'));
    strictEqual(run.advanceProblem('attempt'), null);
    run.nextAttempt();
    ok(run.advanceProblem('attempt') !== null, 'попытка 2 ещё не проверена');
  });
});
