import { STAGE_ORDER } from '@sdlc-runner/shared';

export const RECOVERY_TASKS = ['vat-rounding', 'two-right-answers', 'config-default', 'migration-compat', 'security-bait'];

/** Механика, смысл и стабильность условий проверяются независимо. */
export function modelReadiness(args: {
  model: string;
  currentInputs: number;
  expectedCases: readonly string[];
  currentSourceHash: string;
  report: Record<string, any>;
  results: Array<{ caseId: string; raw: Record<string, any>; accepted: boolean; problems: string[] }>;
  cycles: Array<{ raw: Record<string, any>; accepted: boolean }>;
}): { ready: boolean; diagnosticsPassed: boolean; cyclesPassed: number; reason: string } {
  const no = (reason: string) => ({ ready: false, diagnosticsPassed: false, cyclesPassed: 0, reason });
  if (args.currentInputs !== 15) return no('не все 15 входов доступны');
  if (args.report.fingerprint?.sourceHash !== args.currentSourceHash) return no('исходники изменились');
  if (args.report.preflight?.exitCode !== 0) return no('preflight не пройден');
  if (args.report.repeats < 5) return no('нужны пять повторов диагностики');
  for (const id of args.expectedCases) {
    const entries = args.results.filter((r) => r.caseId === id);
    if (entries.length < 5 || entries.some((r) => !r.accepted || r.problems.length)) return no(`не подтверждены пять повторов ${id}`);
  }
  const baseline = args.results[0]?.raw.diagnostics?.passport;
  const sameConditions = (raw: Record<string, any>) => {
    const passport = raw.diagnostics?.passport;
    const routes = Object.values(raw.run?.routes ?? {});
    return baseline?.sourceHash && baseline?.configHash && passport?.sourceHash === baseline.sourceHash
      && passport?.configHash === baseline.configHash && raw.run?.model === args.model
      && routes.length === 7 && routes.every((route) => route === args.model)
      && Object.keys(passport.localEndpoints ?? {}).length > 0
      && JSON.stringify(passport.localEndpoints) === JSON.stringify(baseline.localEndpoints);
  };
  if (!args.results.every((r) => sameConditions(r.raw))) return no('разные или неполные паспорта условий');
  for (const id of args.expectedCases) {
    const hashes = new Set(args.results.filter((r) => r.caseId === id).map((r) => r.raw.diagnostics?.passport?.inputHash));
    if (hashes.size !== 1 || hashes.has(undefined)) return no(`изменился вход ${id}`);
  }
  const cyclesPassed = RECOVERY_TASKS.filter((task) => args.cycles.some(({ raw, accepted }) => accepted
    && raw.run?.task === task && raw.run?.mode?.kind === 'all' && sameConditions(raw)
    && raw.diagnostics?.state === 'finished' && raw.finalVerdict?.passed === true && raw.hidden?.fail === 0
    && STAGE_ORDER.every((stage) => raw.driver?.stages?.some((s: Record<string, any>) => s.stage === stage && s.ok
      && (!s.skipped || (stage === 'ask' && s.note === 'открытых вопросов нет — этап условный, артефакт не создаётся')))))).length;
  return { ready: cyclesPassed === 5, diagnosticsPassed: true, cyclesPassed,
    reason: cyclesPassed === 5 ? 'подтверждена' : `полных задач ${cyclesPassed}/5` };
}
