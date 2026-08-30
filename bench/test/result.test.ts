/**
 * Проверка сборки файла результата (шаг 3 ROADMAP.md) — герметично.
 *
 * `buildResult`/`writeResult` ничего не считают сами: доказывается, что они складывают уже
 * посчитанные части (`DriverResult`, `RunMetrics`, `OperatorDecisionLog`, `CollectorState`)
 * без потерь и без пересчёта, и что `result.json` реально появляется на диске и парсится
 * обратно тем же значением.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunMetrics, Verdict } from '@sdlc-runner/shared';

import { buildResult, writeResult } from '../src/result.ts';
import type { DriverResult } from '../src/driver.ts';
import { emptyOperatorLog } from '../src/operator.ts';
import { emptyCollectorState } from '../src/collector.ts';
import type { BuiltProfile } from '../src/profile.ts';

function emptyMetrics(): RunMetrics {
  return { stages: [], verdicts: { total: 0, red: 0 }, redByCause: [], attemptsByChunk: [], friction: [] };
}

describe('buildResult', () => {
  it('складывает части без пересчёта', () => {
    const verdict: Verdict = { passed: true, action: 'continue', reasons: [] };
    const driver: DriverResult = {
      stages: [
        { stage: 'intent', chunk: 1, attempt: 1, ok: true, note: 'ок', blockers: [], timedOut: false, skipped: false },
      ],
      finalVerdict: verdict,
      stopped: 'handoff',
    };
    const built: BuiltProfile = {
      project: { name: 'bench', projectRoot: '/tmp/x', activeProfile: 'control', maxBudgetUsd: 5, profiles: {} },
      profile: {
        label: 'контроль',
        routes: {} as BuiltProfile['profile']['routes'],
        ensemble: {},
      } as BuiltProfile['profile'],
      measured: ['intent'],
      routes: {
        intent: 'claude-sdk:haiku',
        explore: 'claude-sdk:sonnet',
        ask: 'claude-sdk:haiku',
        plan: 'claude-sdk:sonnet',
        chunk: 'claude-sdk:sonnet',
        verify: 'claude-sdk:opus',
        handoff: 'claude-sdk:haiku',
      },
    };
    const operator = emptyOperatorLog();
    operator.notMine.push({ requestId: 'req-1', reason: 'policy' });
    const observed = emptyCollectorState();
    observed.toolCalls.push({ stage: 'intent', toolName: 'Read', kind: 'read' });

    const startedAt = new Date('2026-08-29T10:00:00.000Z');
    const finishedAt = new Date('2026-08-29T10:05:00.000Z');

    const result = buildResult({
      opts: {
        mode: { kind: 'stage', stage: 'intent' },
        model: 'claude-sdk:haiku',
        task: 'oversize',
        slug: 'bench-x',
        controlOverrides: {},
        stageTimeoutMs: 1,
        runTimeoutMs: 1,
        maxIterationsPerStage: 1,
        maxBudgetUsd: 1,
        attempts: 1,
        keepWorkspace: false,
        dryRun: false,
        probe: false,
        snapshotAfter: 'plan',
        makeSnapshot: null,
        fromSnapshot: null,
      },
      built,
      startedAt,
      finishedAt,
      driver,
      metrics: emptyMetrics(),
      operator,
      observed,
    });

    strictEqual(result.run.slug, 'bench-x');
    strictEqual(result.run.model, 'claude-sdk:haiku');
    strictEqual(result.run.startedAt, startedAt.toISOString());
    strictEqual(result.run.finishedAt, finishedAt.toISOString());
    deepStrictEqual(result.driver, driver);
    deepStrictEqual(result.finalVerdict, verdict);
    deepStrictEqual(result.operator, operator);
    deepStrictEqual(result.observed, observed);
    deepStrictEqual(result.metrics, emptyMetrics());
  });
});

describe('writeResult', () => {
  it('пишет result.json на диск, каталог создаётся сам', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-result-'));
    try {
      const path = join(root, 'nested', 'result.json');
      const payload = {
        run: {
          slug: 's',
          model: 'm',
          mode: { kind: 'stage' as const, stage: 'intent' as const },
          profileLabel: 'l',
          routes: {
            intent: 'm',
            explore: 'm',
            ask: 'm',
            plan: 'm',
            chunk: 'm',
            verify: 'm',
            handoff: 'm',
          },
          measured: [],
          startedAt: '2026-08-29T10:00:00.000Z',
          finishedAt: '2026-08-29T10:00:01.000Z',
        },
        driver: { stages: [], finalVerdict: null, stopped: 'handoff' as const },
        metrics: emptyMetrics(),
        finalVerdict: null,
        operator: emptyOperatorLog(),
        observed: emptyCollectorState(),
      };
      writeResult(path, payload);

      const text = readFileSync(path, 'utf8');
      ok(text.endsWith('\n'));
      deepStrictEqual(JSON.parse(text), payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
