import type { BenchResult } from './result.ts';
import { guidedSuiteSuccess } from '../../tools/guided-suite-success.ts';
import type { PreflightReport } from './preflight.ts';

export interface ValidationIdentity { slug: string; model: string; task: string; startedAt: string; finishedAt: string; guidedEngineVersion?: 4 | 5 }

/** A shared filename or zero exit status is never evidence that a result belongs to this invocation. */
export function currentGuidedResult(value: unknown, expected: ValidationIdentity): value is BenchResult {
  if (!value || typeof value !== 'object') return false;
  const run = (value as Partial<BenchResult>).run;
  const candidate = value as Partial<BenchResult>;
  if (!candidate.driver || !Array.isArray(candidate.driver.stages) || typeof candidate.driver.stopped !== 'string' ||
      candidate.driver.stages.some(stage => !stage || typeof stage.stage !== 'string' || typeof stage.ok !== 'boolean')) return false;
  if (candidate.finalVerdict !== null && (!candidate.finalVerdict || typeof candidate.finalVerdict.passed !== 'boolean' ||
      !Array.isArray(candidate.finalVerdict.reasons) || candidate.finalVerdict.reasons.some(reason => typeof reason !== 'string'))) return false;
  if (!run || run.slug !== expected.slug || run.model !== expected.model || run.task !== expected.task ||
      run.executionMode !== 'guided' || run.guidedEngineVersion !== (expected.guidedEngineVersion ?? 4) || run.preparationVersion !== 3 || run.strictQuestions !== true) return false;
  const times = [expected.startedAt, run.startedAt, run.finishedAt, expected.finishedAt].map(Date.parse);
  return times.every(Number.isFinite) && times.every((time, index) => index === 0 || time >= times[index - 1]!);
}

export function assessGuidedValidation(value: unknown, expected: ValidationIdentity, exitCode: number | null,
  preflight?: PreflightReport & { slug: string; startedAt: string; finishedAt: string }) {
  if (preflight && !preflight.passed && preflight.slug === expected.slug && preflight.model === expected.model && preflight.task === expected.task &&
    Number.isFinite(Date.parse(preflight.startedAt)) && Number.isFinite(Date.parse(preflight.finishedAt)) &&
    Date.parse(preflight.startedAt) >= Date.parse(expected.startedAt) && Date.parse(preflight.finishedAt) >= Date.parse(preflight.startedAt) && Date.parse(preflight.finishedAt) <= Date.parse(expected.finishedAt))
    return { status: 'preflight-failed', success: false, exitCode, preflight,
      reason: preflight.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail}`).join('; '),
      diagnosis: preflight.envBlocked ? 'environment' : 'model-probe-failure' };
  if (!currentGuidedResult(value, expected)) return {
    status: 'no-current-result', success: false, reason: value ? 'Result identity, protocol or invocation timestamps do not match' : 'No result; inspect preflight/launcher log',
    exitCode, diagnosis: 'unassessed',
  };
  const stages = value.driver.stages;
  const failed = stages.find(stage => !stage.ok);
  const success = exitCode === 0 && guidedSuiteSuccess(value);
  return {
    status: success ? 'success' : stages.some(stage => stage.envFailure) ? 'environment-failure' : 'failed', success,
    exitCode, stopped: value.driver.stopped, failedStage: failed?.stage ?? null,
    reason: failed?.note ?? value.finalVerdict?.reasons.join('; ') ?? value.driver.stopped,
    failure: failed?.failure ?? null, diagnosis: success ? 'accepted' : 'unassessed',
    reached: stages.map(stage => ({ stage: stage.stage, ok: stage.ok, skipped: stage.skipped })),
    hidden: value.hidden, finalVerdict: value.finalVerdict,
    modelRequests: stages.reduce((sum, stage) => sum + (stage.decisionStats?.complete ? stage.decisionStats.requests : stage.modelRequests ?? stage.turns ?? 0), 0),
    diagnostic: failed?.diagnostic ?? null,
    firstMutation: value.guided?.workload?.firstMutation ?? null,
    activeMs: value.guided?.activeMs ?? null,
  };
}
