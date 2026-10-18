import type { ExecutionEntry, ExecutionOperation, ExecutionSummary, ModelWorkPurpose, Usage } from '@sdlc-runner/shared';

/** Read-only projection. Usage comes only from model_work, never HTTP snapshots. */
export function executionSummary(entries: readonly ExecutionEntry[], recordingHealthy = true): ExecutionSummary {
  entries = [...new Map(entries.map(entry => [entry.id, entry])).values()];
  const result: ExecutionSummary = { complete: recordingHealthy, limitations: [], operations: 0, active: [], interrupted: 0,
    checks: { passed: 0, failed: 0, firstAttemptPassed: 0, itemsChecked: 0 }, repeatedFailures: 0, rollbacks: 0, byPurpose: {},
    timeToFirstMutationMs: null, timeToFirstPassingCheckMs: null, toolDurationMs: 0, checkDurationMs: 0, humanWaitMs: 0, incompleteContexts: 0, failures: {} };
  const open = new Map<string, { entry: ExecutionEntry; operation: ExecutionOperation }>();
  const checked = new Set<string>(); const failures = new Map<string, string>();
  const began = entries.find(e => e.kind === 'stage_entered' || e.kind === 'stage_started')?.at;
  const elapsed = (at: string) => began && Number.isFinite(Date.parse(at) - Date.parse(began)) ? Math.max(0, Date.parse(at) - Date.parse(began)) : null;
  const waits = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'execution_operation') {
      const op = entry.payload as ExecutionOperation;
      if (op.phase === 'started') { open.set(op.id, { entry, operation: op }); result.operations++; }
      else {
        open.delete(op.id);
        if (op.status === 'interrupted') result.interrupted++;
        if (op.kind === 'rollback') result.rollbacks++;
        if (op.kind === 'apply' && op.status === 'passed' && result.timeToFirstMutationMs === null) result.timeToFirstMutationMs = elapsed(entry.at);
        if (op.kind === 'context' && (op.evidence as { partial?: boolean } | undefined)?.partial) result.incompleteContexts++;
        if (op.kind === 'check') {
          result.checkDurationMs += op.durationMs ?? 0;
          const evidence = op.evidence as { passed?: boolean; result?: string } | undefined;
          const passed = op.status === 'passed' && evidence?.passed === true;
          result.checks[passed ? 'passed' : 'failed']++;
          if (passed && result.timeToFirstPassingCheckMs === null) result.timeToFirstPassingCheckMs = elapsed(entry.at);
          const key = `${entry.invocation}:${op.itemId}`;
          if (!checked.has(key)) { checked.add(key); result.checks.itemsChecked++; if (passed) result.checks.firstAttemptPassed++; }
          if (!passed && evidence?.result) {
            if (failures.get(key) === evidence.result) result.repeatedFailures++;
            failures.set(key, evidence.result);
          }
        }
      }
    }
    if (entry.kind === 'tool_result') result.toolDurationMs += (entry.payload as { durationMs?: number }).durationMs ?? 0;
    if (entry.kind === 'human_questions') {
      const id = (entry.payload as { requestId?: string }).requestId;
      if (id) waits.set(id, Date.parse(entry.at));
    }
    if (entry.kind === 'human_answers') {
      const id = (entry.payload as { requestId?: string }).requestId;
      if (id && waits.has(id)) { result.humanWaitMs += Math.max(0, Date.parse(entry.at) - waits.get(id)!); waits.delete(id); }
    }
    if (entry.kind === 'guided_workload') {
      const event = entry.payload as { kind?: string; reason?: string };
      if (event.kind === 'failure' || event.kind === 'context-overflow') {
        const reason = event.reason ?? event.kind;
        result.failures[reason] = (result.failures[reason] ?? 0) + 1;
      }
    }
    if (entry.kind === 'stage_done' || entry.kind === 'executor_result') {
      for (const [id, value] of open) if (value.entry.invocation === entry.invocation) { open.delete(id); result.interrupted++; }
    }
    if (entry.kind === 'model_work') {
      const p = entry.payload as { usage: Usage; durationMs?: number; work?: { purpose: ModelWorkPurpose; requests?: number }; currency: string };
      const purpose = p.work?.purpose ?? 'unclassified';
      const row = result.byPurpose[purpose] ??= { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, currency: p.currency, durationMs: 0 };
      row.requests = row.requests === null || p.work?.requests === undefined ? null : row.requests + p.work.requests;
      row.inputTokens += p.usage.inputTokens; row.outputTokens += p.usage.outputTokens; row.durationMs += p.durationMs ?? 0;
      row.cost = row.cost === null || p.usage.costUsd === null || row.currency !== p.currency ? null : row.cost + p.usage.costUsd;
      if (row.currency !== p.currency) row.currency = 'mixed';
    }
  }
  result.active = [...open.values()].map(({ entry, operation: op }) => ({ id: op.id, kind: op.kind, itemId: op.itemId, attempt: op.attempt, startedAt: entry.at }));
  if (!entries.some(entry => entry.kind === 'execution_operation')) result.limitations.push('Подробные операции не записаны: исторический или неподдерживаемый режим.');
  if (!recordingHealthy) result.limitations.push('Часть событий не записана из-за ошибки журнала.');
  if (entries.some(e => e.kind === 'usage') && !entries.some(e => e.kind === 'model_work')) result.limitations.push('Расход по назначениям неизвестен.');
  const requested = entries.filter(e => e.kind === 'model_request').length;
  const accounted = Object.values(result.byPurpose).reduce((sum, row) => sum + (row.requests ?? 0), 0);
  if (requested > accounted) result.limitations.push('Для части запросов точный расход неизвестен; незавершённые запросы не считаются бесплатными.');
  result.complete = result.complete && result.limitations.length === 0;
  return result;
}
