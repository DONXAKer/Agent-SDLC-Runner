import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAGE_ORDER, emptyUsage } from '@sdlc-runner/shared';
import type { DashboardCard, DashboardStage, DashboardStageDetail, DashboardStageState, RunSummary } from '@sdlc-runner/shared';

import { flowCounts, hasFailedStage, stageProblems } from '../src/lib/flowTimeline.ts';

function stages(over: Partial<Record<(typeof STAGE_ORDER)[number], DashboardStageState>> = {}): DashboardStage[] {
  return STAGE_ORDER.map((id) => ({ id, title: id, state: over[id] ?? 'notStarted', blamed: null, note: null, outputs: [] }));
}

function live(over: Partial<RunSummary> = {}): RunSummary {
  return { runId: 'run', slug: 'slug', project: 'project', profile: 'local', status: 'running', stage: 'plan', chunk: 1, attempt: 1, attemptBudget: 3, usage: emptyUsage(), waiting: 0, stageStartedAt: null, ...over };
}

function card(over: Partial<DashboardCard> = {}): DashboardCard {
  return { ref: { source: 'ui', project: 'project', slug: 'slug' }, status: 'open', updatedAt: '', chunk: 1, attempt: 1, stages: stages(), usage: null, live: null, bench: null, runCount: 1, ...over };
}

function detail(over: Partial<DashboardStageDetail> = {}): DashboardStageDetail {
  return { ...stages()[0]!, inputs: [], blockers: [], abortBlockers: null, lastRun: null, metrics: null, storedVerdict: null, benchRecord: null, ...over };
}

describe('сводка вертикальной ленты', () => {
  it('считает работу, ожидание и фактически упавший этап отдельно', () => {
    const cards = [
      card({ ref: { source: 'ui', project: 'p', slug: 'running' }, live: live() }),
      card({ ref: { source: 'ui', project: 'p', slug: 'waiting' }, live: live({ status: 'awaiting', waiting: 2 }) }),
      card({ ref: { source: 'ui', project: 'p', slug: 'failed' }, stages: stages({ plan: 'failed' }) }),
      card({ ref: { source: 'terminal', project: 'p', slug: 'done' }, status: 'done' }),
    ];
    deepStrictEqual(flowCounts(cards), { total: 4, running: 1, waiting: 1, failed: 1 });
    strictEqual(hasFailedStage(cards[2]!), true);
    strictEqual(hasFailedStage(cards[3]!), false);
  });

  it('оборванный виток считается ошибкой даже без failed-этапа', () => {
    deepStrictEqual(flowCounts([card({ status: 'aborted' })]).failed, 1);
  });
});

describe('диагностика этапа в модальном окне', () => {
  it('собирает причину исхода, ошибки и вердикт без дублей', () => {
    const problems = stageProblems(detail({
      state: 'failed',
      note: 'Этап не завершился',
      lastRun: {
        runId: 'run', flow: 'loop', provider: 'local', model: 'model', prompt: null, assistantText: '', gates: [],
        verdict: { passed: false, action: 'retry', reasons: ['тест упал'] },
        outcome: { ok: false, note: 'Исполнитель остановлен' }, warnings: ['контекст обрезан'], errors: ['тест упал'], toolCalls: 1,
      },
      storedVerdict: { passed: false, action: 'retry', reasons: ['тест упал'], committedSha: null },
    }));
    deepStrictEqual(problems.errors, ['Этап не завершился', 'Исполнитель остановлен', 'тест упал']);
    deepStrictEqual(problems.warnings, ['контекст обрезан']);
  });

  it('блокеры остаются причинами остановки, а старый архив без ленты не выдумывает детали', () => {
    deepStrictEqual(stageProblems(detail({ state: 'blocked', blockers: [{ text: 'нет plan.md', blamed: 'plan' }] })).errors, ['нет plan.md']);
    deepStrictEqual(stageProblems(detail({ state: 'failed', note: 'failed в старом events.ndjson' })), { errors: ['failed в старом events.ndjson'], warnings: [] });
  });
});
