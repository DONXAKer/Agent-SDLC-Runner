/**
 * «Ревью независимым агентом» не должен блокировать старт этапа проверкой «Чем реализован».
 *
 * Найдено на первом реальном витке CV после появления `unimplementedGates` (fb3fe94):
 * методология описывает этот гейт минимума прозой («агент sdlc-reviewer...»), не командой в
 * обратных кавычках и не именем builtin'а — он получает статус не через `gates/run.ts`, а
 * через `Run.externalGateStatuses()` на прогоне. Проверка на старте этапа этого не знала и
 * блокировала ЛЮБОЙ виток с обычным для минимума набором сразу после `intent`.
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-reviewgate-')));
  roots.push(root);
  return root;
}

const MINIMAL_GATES = [
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да — минимум | этап 6 | `npm run build` |',
  '| Тесты | да — минимум | этап 6 | `npm test` |',
  '| Scope: файлы вне плана | да — минимум | этап 6 | встроенная реализация рантайма |',
  '| Анти-обход тест-гейта | да — минимум | этап 6 | встроенная реализация рантайма |',
  '| Ревью независимым агентом | да — минимум | этап 6 | агент sdlc-reviewer на более сильной модели |',
].join('\n');

describe('гейт минимума «Ревью независимым агентом» не блокирует старт этапа', () => {
  it('обычный набор (минимум прозой) — explore стартует, не падает на «исполнить нечем»', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'gates.md'), MINIMAL_GATES);
    const run = makeRun(root);

    const blockers = run.blockers('explore');
    ok(
      !blockers.some((b) => /Ревью независимым агентом/.test(b) && /исполнить его нечем/.test(b)),
      blockers.join('; '),
    );
  });

  it('свой гейт БЕЗ команды и БЕЗ builtin — по-прежнему блокирует (это не регрессия защиты)', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'gates.md'),
      `${MINIMAL_GATES}\n| Свой гейт | да | этап 6 | проза без обратных кавычек |`,
    );
    const run = makeRun(root);

    const blockers = run.blockers('explore');
    strictEqual(
      blockers.some((b) => /Свой гейт/.test(b) && /исполнить его нечем/.test(b)),
      true,
      blockers.join('; '),
    );
  });
});
