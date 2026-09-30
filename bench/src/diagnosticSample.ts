/** Separate a measured stage failure from a stage that never received a valid input. */
export interface DiagnosticSample {
  slug: string;
  exitCode: number | null;
  outcome: string;
  resultFile?: string;
  stageStarted?: boolean;
  stageOk?: boolean;
  durationMs?: number;
  tokens?: number;
  timedOut?: boolean;
  toolCalls?: number;
  friction?: number;
  seedCaught?: boolean | null;
  semanticAssessment: 'not-assessed';
  problemCodes?: string[];
  reason?: string;
  passport?: { sourceHash?: string; configHash?: string; inputHash?: string; gitHead?: string | null };
}

export function assessDiagnosticSample(
  raw: Record<string, any>, slug: string, exitCode: number | null, stage?: string,
): DiagnosticSample {
  const stages: any[] = raw.driver?.stages ?? [];
  const target = stage ?? raw.run?.mode?.stage;
  const measured = stages.filter((entry) => target === undefined || entry.stage === target);
  const blockers = measured.flatMap((entry) => entry.blockers ?? []);
  const started = measured.some((entry) => !entry.skipped && (entry.blockers ?? []).length === 0);
  const timedOut = measured.some((entry) => entry.timedOut);
  const envFailure = measured.find((entry) => entry.envFailure)?.envFailure;
  const stageOk = started && measured.every((entry) => entry.ok || entry.skipped);
  const finished = raw.diagnostics?.state === 'finished' && exitCode !== null;
  const outcome = !started ? 'not-started' : !finished ? 'incomplete'
    : timedOut ? 'timeout' : envFailure ? 'environment-error'
    : stageOk ? 'completed' : 'stage-failed';
  // A precondition failure never tells us whether the reviewer can find the seed.
  const seedCaught = started && raw.seed?.seedId !== 'none' && typeof raw.seed?.caught === 'boolean' ? raw.seed.caught : null;
  const hiddenFailed = started && ['chunk', 'handoff'].includes(target) && Number(raw.hidden?.fail) > 0;
  const elapsed = Date.parse(raw.run?.finishedAt ?? '') - Date.parse(raw.run?.startedAt ?? '');
  const problemCodes = [
    ...(!started ? ['INPUT_BLOCKED'] : []),
    ...(started && !finished ? ['INCOMPLETE'] : []),
    ...(timedOut ? ['TIMEOUT'] : []),
    ...(envFailure ? ['ENV_FAILURE'] : []),
    ...(started && !stageOk && !timedOut && !envFailure && seedCaught !== true ? ['STAGE_FAILED'] : []),
    ...(seedCaught === false ? ['SEED_MISSED'] : []),
    ...(hiddenFailed ? ['HIDDEN_TEST_FAILED'] : []),
  ];
  return {
    slug, exitCode, outcome, stageStarted: started, stageOk, timedOut, seedCaught,
    semanticAssessment: 'not-assessed', problemCodes,
    ...(Number.isFinite(elapsed) ? { durationMs: Math.max(0, elapsed) } : {}),
    ...(Array.isArray(raw.metrics?.stages) ? { tokens: raw.metrics.stages.reduce((n: number, entry: any) =>
      n + (Number(entry.usage?.inputTokens) || 0) + (Number(entry.usage?.outputTokens) || 0), 0) } : {}),
    toolCalls: raw.observed?.toolCalls?.length ?? 0,
    friction: raw.metrics?.friction?.reduce((n: number, entry: any) => n +
      ['repeat', 'badJson', 'denied', 'truncated'].reduce((m, key) => m + (Number(entry[key]) || 0), 0), 0),
    reason: blockers.length ? blockers.join('; ') : envFailure ?? measured.find((entry) => !entry.ok)?.note,
    passport: raw.diagnostics?.passport,
  };
}
