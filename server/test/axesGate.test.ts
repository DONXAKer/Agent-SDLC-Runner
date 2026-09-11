/**
 * Проводка гейта «Разбор последствий»: от строки набора до строки в отчёте приёмки.
 *
 * Чистая функция разбора покрыта отдельно (`planAxes.test.ts`), а здесь — ровно тот шов,
 * который ревью нашло непокрытым: выбор строки набора, уважение колонки «Где отчитывается»,
 * поведение при отсутствующих артефактах и глиф статуса. Дефекты этого шва не видны ни
 * одному тесту чистой функции: гейт может быть выключён целиком, и все они останутся
 * зелёными.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import { AXES } from '../src/artifacts/planAxes.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { Run } from '../src/run/Run.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-axes-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  return root;
}

function route(stage: StageId): ResolvedRoute {
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
    planAxisFill: false,
    stepFill: false,
    compactForms: 'off',
    exploreIndex: false,
    exploreFill: false,
  };
}

function makeRun(root: string): Run {
  const routes = Object.fromEntries(STAGE_ORDER.map((s) => [s, route(s)])) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<StageId, ResolvedRoute[]>;
  const profile: ResolvedProfile = { name: 'demo', label: 'demo', routes, ensemble };
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
    profile,
    slug: 'demo',
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: () => {},
  });
}

function gates(rows: string[]): string {
  return [
    '# Набор гейтов',
    '',
    '## Набор',
    '',
    '| Гейт | Вкл | Где отчитывается | Чем реализован |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

const РАЗБОР_ВКЛ = '| Разбор последствий | да | этап 4 | проза |';

/** План, где все шесть осей закрыты «н/п» с причиной — канон без проблем. */
function планКанон(): string {
  return [
    '# План: тест',
    '',
    '## Последствия шагов',
    '',
    '| Ось | Затронута шагами | Что именно в шагах | Исход |',
    '|---|---|---|---|',
    ...AXES.map((a) => `| ${a} | нет | шаг 1: не трогаем | н/п — ось не затронута |`),
    '',
  ].join('\n');
}

function задача(): string {
  return ['# Задача: тест', '', '| claim-1 | пункт | тест |', ''].join('\n');
}

describe('строка набора решает, работает ли гейт', () => {
  it('гейта нет в наборе — проверять нечего', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates(['| Сборка | да | этап 6 | `npm run build` |']));
    const run = makeRun(root);
    deepStrictEqual(run.axisProblems(), []);
    deepStrictEqual(run.earlyGateRows(), []);
  });

  it('гейт выключен — проверять нечего, строки в отчёте нет', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates(['| Разбор последствий | нет — долг | этап 4 | проза |']));
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), планКанон());
    const run = makeRun(root);
    deepStrictEqual(run.axisProblems(), []);
    deepStrictEqual(run.earlyGateRows(), []);
  });

  it('гейт перенесён проектом на другой этап — здесь он не проверяется', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates(['| Разбор последствий | да | этап 6 | проза |']));
    const run = makeRun(root);
    deepStrictEqual(run.axisProblems(), []);
    deepStrictEqual(run.earlyGateRows(), []);
  });
});

describe('отсутствующий артефакт — отказ проверки, а не её зелёный исход', () => {
  it('плана нет — это проблема, а не «разбор доведён»', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates([РАЗБОР_ВКЛ]));
    const run = makeRun(root);
    const problems = run.axisProblems();
    strictEqual(problems.length, 1);
    ok(/plan\.md/.test(problems[0] ?? ''), problems[0]);
    // И в отчёте приёмки строка красная: молчание зеленило гейт по несуществующему плану.
    strictEqual(run.earlyGateRows()[0]?.status, '❌');
  });

  it('задачи нет — адресатов исходов проверять не по чему', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates([РАЗБОР_ВКЛ]));
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), планКанон());
    const run = makeRun(root);
    const problems = run.axisProblems();
    strictEqual(problems.length, 1);
    ok(/intent\.md/.test(problems[0] ?? ''), problems[0]);
  });
});

describe('статус строки в отчёте приёмки', () => {
  it('разбор доведён — ✅ со ссылкой на секцию плана', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates([РАЗБОР_ВКЛ]));
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), планКанон());
    writeFileSync(join(root, '.sdlc', 'demo', 'intent.md'), задача());
    const run = makeRun(root);
    deepStrictEqual(run.axisProblems(), []);
    const row = run.earlyGateRows()[0];
    strictEqual(row?.status, '✅');
    ok(/plan\.md/.test(row?.seenIn ?? ''), row?.seenIn);
  });

  it('разбор не доведён — ❌, а не снимаемое подписью ⏭', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.sdlc', 'gates.md'), gates([РАЗБОР_ВКЛ]));
    writeFileSync(join(root, '.sdlc', 'demo', 'intent.md'), задача());
    // Одна ось закрыта пустым исходом — разбор недоведён.
    const rows = AXES.map((a, i) =>
      i === 0 ? `| ${a} | да | шаг 1: трогаем | |` : `| ${a} | нет | шаг 1: не трогаем | н/п — ось не затронута |`,
    );
    writeFileSync(
      join(root, '.sdlc', 'demo', 'plan.md'),
      ['# План: тест', '', '## Последствия шагов', '', '| Ось | Затронута шагами | Что именно в шагах | Исход |', '|---|---|---|---|', ...rows, ''].join('\n'),
    );
    const run = makeRun(root);
    ok(run.axisProblems().length > 0);
    strictEqual(run.earlyGateRows()[0]?.status, '❌');
  });
});
