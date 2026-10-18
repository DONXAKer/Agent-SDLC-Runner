import type { BenchResult } from './result.ts';

/** All requirements must be evidenced; missing reports never count as successes. */
export function guidedAcceptance(result: BenchResult | null, mode: 'legacy' | 'guided'): { success: boolean; activeMs: number | null } {
  if (!result) return { success: false, activeMs: null };
  const activeMs = mode === 'guided' ? result.guided?.activeMs ?? null : Math.max(0,
    result.metrics.stages.reduce((sum, stage) => sum + stage.durationMs, 0) - result.metrics.human.reduce((sum, human) => sum + human.waitMs, 0));
  const hidden = result.hidden;
  const success = result.finalVerdict?.passed === true && result.driver.stopped === 'handoff' &&
    result.run.executionMode === mode && result.run.preparationVersion === 3 && result.run.strictQuestions === true &&
    hidden !== null && hidden.total > 0 && hidden.fail === 0 && hidden.pass === hidden.total && hidden.skipped === 0 && hidden.errorText === null &&
    result.honesty.every(check => check.ok !== false) && activeMs !== null && Number.isFinite(activeMs) && activeMs <= 30 * 60000;
  return { success, activeMs };
}
