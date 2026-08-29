import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunMetrics, Verdict } from '@sdlc-runner/shared';

import { buildResult } from '../src/result.ts';
import type { DriverResult } from '../src/driver.ts';
import { emptyOperatorLog } from '../src/operator.ts';
import { emptyCollectorState } from '../src/collector.ts';
import type { BuiltProfile } from '../src/profile.ts';
import { buildReport } from '../src/report.ts';
import { draftJournalEntry } from '../src/journal.ts';

const ROUTES: BuiltProfile['routes'] = {
  intent: 'claude-sdk:haiku',
  explore: 'claude-sdk:sonnet',
  ask: 'claude-sdk:haiku',
  plan: 'claude-sdk:sonnet',
  chunk: 'claude-sdk:sonnet',
  verify: 'claude-sdk:opus',
  handoff: 'claude-sdk:haiku',
};

function result(stagesOk: boolean) {
  const verdict: Verdict = { passed: stagesOk, action: stagesOk ? 'continue' : 'escalate', reasons: [] };
  const driver: DriverResult = {
    stages: [
      { stage: 'intent', chunk: 1, attempt: 1, ok: true, note: 'этап завершён за 12 ход(ов)', blockers: [], timedOut: false, skipped: false },
      { stage: 'chunk', chunk: 1, attempt: 1, ok: stagesOk, note: stagesOk ? 'этап завершён за 20 ход(ов)' : 'ноль вызовов инструментов', blockers: [], timedOut: false, skipped: false },
    ],
    finalVerdict: verdict,
    stopped: stagesOk ? 'handoff' : 'blocked',
  };
  const m: RunMetrics = {
    stages: [{ stage: 'intent', runs: 1, usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.09, durationMs: 1000 }, durationMs: 1000 }],
    verdicts: { total: 1, red: stagesOk ? 0 : 1 },
    redByCause: [],
    attemptsByChunk: [],
    friction: [],
  };
  return buildResult({
    opts: {
      mode: { kind: 'all' },
      model: 'ollama:qwen2.5-coder:7b',
      task: 'oversize',
      slug: 'bench-test',
      controlOverrides: {},
      stageTimeoutMs: 1,
      runTimeoutMs: 1,
      maxIterationsPerStage: 1,
      maxBudgetUsd: 1,
      attempts: 1,
      keepWorkspace: false,
      dryRun: false,
      makeSnapshot: null,
      fromSnapshot: null,
    },
    built: {
      project: { name: 'bench', projectRoot: '/tmp/x', activeProfile: 'control', maxBudgetUsd: 5, profiles: {} },
      profile: { label: 'контроль', routes: {} as BuiltProfile['profile']['routes'], ensemble: {} } as BuiltProfile['profile'],
      measured: ['intent', 'chunk'],
      routes: ROUTES,
    },
    startedAt: new Date('2026-08-29T10:00:00.000Z'),
    finishedAt: new Date('2026-08-29T10:20:00.000Z'),
    driver,
    metrics: m,
    operator: emptyOperatorLog(),
    observed: emptyCollectorState(),
  });
}

describe('draftJournalEntry', () => {
  it('заголовок содержит id модели и дату из finishedAt', () => {
    const r = result(true);
    const report = buildReport({ result: r, hidden: null, honesty: [] });
    const draft = draftJournalEntry({ result: r, report });
    ok(draft.startsWith('## `ollama:qwen2.5-coder:7b`'));
    ok(draft.includes('2026-08-29'));
  });

  it('шапка ✅/❌/— повторяет формат docs/model-runs.md', () => {
    const r = result(false);
    const report = buildReport({ result: r, hidden: null, honesty: [] });
    const draft = draftJournalEntry({ result: r, report });
    ok(/\| ✅ \| ❌ \| — \|/.test(draft));
  });

  it('в конце оставлено место для решения человека — не выдаёт готовый вердикт', () => {
    const r = result(true);
    const report = buildReport({ result: r, hidden: null, honesty: [] });
    const draft = draftJournalEntry({ result: r, report });
    ok(draft.includes('‹дописать словами'));
    ok(draft.includes('заполняет человек'));
  });

  it('опасная модель помечена в заголовке', () => {
    const r = result(true);
    r.operator.approvals.push({
      stage: 'chunk',
      requestId: 'x',
      kind: 'write',
      toolName: 'Write',
      targets: ['a'],
      destructive: 'd',
      outcome: 'granted',
      why: 'w',
      waitedMs: 1,
    });
    const report = buildReport({ result: r, hidden: null, honesty: [] });
    const draft = draftJournalEntry({ result: r, report });
    ok(draft.includes('ОПАСНА'));
  });

  it('стоимость печатается, когда посчитана; «не изм.» — когда costUsd null (локальный провайдер)', () => {
    const r = result(true);
    const withCost = draftJournalEntry({ result: r, report: buildReport({ result: r, hidden: null, honesty: [] }) });
    ok(withCost.includes('$0.09'));

    r.metrics.stages[0]!.usage = { ...r.metrics.stages[0]!.usage, costUsd: null };
    const noCost = draftJournalEntry({ result: r, report: buildReport({ result: r, hidden: null, honesty: [] }) });
    ok(noCost.includes('не изм.'));
    strictEqual(noCost.includes('$0.09'), false);
  });
});
