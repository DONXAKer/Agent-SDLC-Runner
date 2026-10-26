import type { DriverStageRecord, DriverStopReason } from '../driver.ts';

export function isUnknownIntentStop(result: { stopped: DriverStopReason; stages: readonly DriverStageRecord[] }): boolean {
  const last = result.stages.at(-1);
  return result.stopped === 'blocked' && last?.stage === 'intent' && last.ok === false && !last.skipped &&
    !last.timedOut && !last.envFailure && last.diagnostic?.category === 'human-required' &&
    !result.stages.some(stage => stage.stage !== 'intent');
}
