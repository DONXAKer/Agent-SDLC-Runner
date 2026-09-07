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
import type { BenchResult } from '../src/result.ts';
import type { DriverResult } from '../src/driver.ts';
import { emptyOperatorLog } from '../src/operator.ts';
import { emptyCollectorState } from '../src/collector.ts';
import type { BuiltProfile } from '../src/profile.ts';
import { buildReport } from '../src/report.ts';
import type { HiddenTestsSummary } from '../src/hiddenTests.ts';
import type { HonestyCheck } from '../src/honesty.ts';

function emptyMetrics(): RunMetrics {
  return { stages: [], verdicts: { total: 0, red: 0 }, redByCause: [], attemptsByChunk: [], friction: [], gates: [], human: [], artifactGaps: [] };
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
      currencies: {} as BuiltProfile['currencies'],
    };
    const operator = emptyOperatorLog();
    operator.notMine.push({ stage: 'chunk', requestId: 'req-1', reason: 'policy' });
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
        repeat: 1,
        seed: null,
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
    strictEqual(result.hidden, null);
    deepStrictEqual(result.honesty, []);
  });
});

describe('инвариант «result.json пересобирает отчёт целиком»', () => {
  it('buildReport работает от одного распарсенного result.json, без живых объектов', () => {
    const verdict: Verdict = { passed: true, action: 'continue', reasons: [] };
    const driver: DriverResult = {
      stages: [
        { stage: 'chunk', chunk: 1, attempt: 1, ok: true, note: 'этап завершён за 12 ход(ов)', blockers: [], timedOut: false, skipped: false },
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
      measured: ['chunk'],
      routes: {
        intent: 'claude-sdk:haiku',
        explore: 'claude-sdk:haiku',
        ask: 'claude-sdk:haiku',
        plan: 'claude-sdk:haiku',
        chunk: 'm',
        verify: 'claude-sdk:opus',
        handoff: 'claude-sdk:haiku',
      },
      currencies: {} as BuiltProfile['currencies'],
    };
    const hidden: HiddenTestsSummary = {
      total: 2,
      pass: 2,
      fail: 0,
      skipped: 0,
      errorText: null,
      cases: [
        { id: 'Pr1', category: 'precision', ok: true, skipped: false, label: 'Pr1' },
        { id: 'H1', category: 'human', ok: true, skipped: false, label: 'H1' },
      ],
    };
    const honesty: HonestyCheck[] = [
      { method: 'journalClaimsVsBash', ok: null, detail: 'нет утверждения' },
      { method: 'diffMatchesTree', ok: true, detail: 'ок' },
      { method: 'hiddenTests', ok: true, detail: '2 из 2' },
      { method: 'destructiveOrPolicyDenied', ok: true, detail: 'ок' },
    ];

    const result = buildResult({
      opts: {
        mode: { kind: 'stage', stage: 'chunk' },
        model: 'm',
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
        repeat: 1,
        seed: null,
      },
      built,
      startedAt: new Date('2026-08-29T10:00:00.000Z'),
      finishedAt: new Date('2026-08-29T10:05:00.000Z'),
      driver,
      metrics: emptyMetrics(),
      operator: emptyOperatorLog(),
      observed: emptyCollectorState(),
      hidden,
      honesty,
    });

    // Единственный «вход» — текст файла: всё, что читает отчёт, обязано пережить
    // сериализацию. Иначе по ходу прогона структурные результаты терялись бы.
    const parsed = JSON.parse(JSON.stringify(result)) as BenchResult;
    const report = buildReport({ result: parsed, hidden: parsed.hidden, honesty: parsed.honesty });

    strictEqual(report.exitCode, 0);
    strictEqual(report.dangerous, false);
    ok(report.markdown.includes('| точность правки | ✅ |'), 'таблица щупов собрана из JSON');
    ok(report.markdown.includes('1 из 1 precision/regression-кейсов зелёные'), 'детали hidden читаются из JSON');
    ok(report.markdown.includes('| вопросы человеку | ✅ |'), 'human-кейсы читаются из JSON');
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
          task: 'oversize',
          fixtureDir: 'fixture',
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
          currencies: {} as BuiltProfile['currencies'],
          measured: [],
          startedAt: '2026-08-29T10:00:00.000Z',
          finishedAt: '2026-08-29T10:00:01.000Z',
        },
        driver: { stages: [], finalVerdict: null, stopped: 'handoff' as const },
        metrics: emptyMetrics(),
        finalVerdict: null,
        operator: emptyOperatorLog(),
        observed: emptyCollectorState(),
        seed: null,
        hidden: null,
        honesty: [],
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
