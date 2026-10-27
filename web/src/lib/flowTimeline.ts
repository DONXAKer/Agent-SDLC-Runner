import type { DashboardCard, DashboardStageDetail } from '@sdlc-runner/shared';

import { isRunningNow } from './dashboardSort.ts';

export interface FlowCounts {
  total: number;
  running: number;
  waiting: number;
  failed: number;
}

export function hasFailedStage(card: Pick<DashboardCard, 'stages'>): boolean {
  return card.stages.some((stage) => stage.state === 'failed');
}

export function isWaitingForHuman(card: Pick<DashboardCard, 'live'>): boolean {
  return card.live !== null && (card.live.waiting > 0 || card.live.status === 'awaiting');
}

export function flowCounts(cards: readonly DashboardCard[]): FlowCounts {
  return {
    total: cards.length,
    running: cards.filter((card) => isRunningNow(card) && !isWaitingForHuman(card)).length,
    waiting: cards.filter(isWaitingForHuman).length,
    failed: cards.filter((card) => card.status === 'aborted' || hasFailedStage(card)).length,
  };
}

export interface StageProblems {
  errors: string[];
  warnings: string[];
}

function unique(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line !== ''))];
}

export function stageProblems(stage: DashboardStageDetail): StageProblems {
  const errors: string[] = [];
  if ((stage.state === 'failed' || stage.state === 'blocked') && stage.note !== null) errors.push(stage.note);
  if (stage.lastRun?.outcome?.ok === false) errors.push(stage.lastRun.outcome.note);
  errors.push(...(stage.lastRun?.errors ?? []));
  errors.push(...stage.blockers.map((blocker) => blocker.text));
  if (stage.lastRun?.verdict?.passed === false) errors.push(...stage.lastRun.verdict.reasons);
  if (stage.storedVerdict?.passed === false) errors.push(...stage.storedVerdict.reasons);
  if (stage.benchRecord !== null && !stage.benchRecord.ok) {
    errors.push(stage.benchRecord.note);
    if (stage.benchRecord.envFailure !== null) errors.push(stage.benchRecord.envFailure);
    if (stage.benchRecord.timedOut) errors.push('Превышено время выполнения этапа');
  }
  return { errors: unique(errors), warnings: unique(stage.lastRun?.warnings ?? []) };
}
