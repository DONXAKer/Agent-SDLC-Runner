import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_CLASSES, classifyFailure, compareFailureClasses, type FailureClassInput } from '../src/failureClass.ts';
import type { DriverStageRecord } from '../src/driver.ts';

const stage = (over: Partial<DriverStageRecord>): DriverStageRecord => ({ stage: 'chunk', chunk: 1, attempt: 1, ok: false, note: 'n', blockers: [], timedOut: false, skipped: false, ...over });
const okStage = (id: DriverStageRecord['stage']): DriverStageRecord => stage({ stage: id, ok: true });
function input(failed: Partial<DriverStageRecord> | null, over: Partial<FailureClassInput> & { stopped?: string; failures?: Record<string, number>; incomplete?: { cause: 'wall-clock' | 'requests' | 'output-tokens' | 'cost' } } = {}): FailureClassInput {
  const { stopped = 'blocked', failures, incomplete, ...rest } = over;
  return { success: false, status: 'failed', result: {
    driver: { stages: [okStage('intent'), okStage('explore'), ...(failed ? [stage(failed)] : [])], finalVerdict: null, stopped: stopped as never,
      ...(incomplete ? { incomplete: { ...incomplete, detail: '', units: [] } } : {}) },
    guided: failures ? { workload: { failures } } as never : null,
  }, ...rest };
}

test('словарь закрыт и без дублей', () => {
  assert.equal(new Set(FAILURE_CLASSES).size, FAILURE_CLASSES.length);
  assert.ok(FAILURE_CLASSES.includes('none') && FAILURE_CLASSES.includes('unknown'));
});

test('успех и «модель не измерялась» идут первыми', () => {
  assert.equal(classifyFailure({ ...input(null), success: true, status: 'success' }), 'none');
  assert.equal(classifyFailure({ ...input(null), status: 'preflight-failed' }), 'preflight');
  assert.equal(classifyFailure(input(null, { coordinatorError: 'Coordinator wall-clock timeout' })), 'wall-clock');
  assert.equal(classifyFailure(input(null, { coordinatorError: 'Engine layout failure: placement' })), 'env');
  assert.equal(classifyFailure({ success: false, status: 'no-current-result', result: null }), 'harness');
  assert.equal(classifyFailure(input({ envFailure: 'HTTP 502' })), 'env');
});

test('бюджеты: стенные часы, токены, запросы', () => {
  assert.equal(classifyFailure(input({ stage: 'plan', stopCause: 'stage-deadline', diagnostic: { category: 'budget' } }, { stopped: 'stage-timeout' })), 'wall-clock');
  // Стенд красит таймаут этапа «средой» — класс всё равно часы, иначе сдвиг после правки лимитов не виден.
  assert.equal(classifyFailure(input({ stage: 'plan', stopCause: 'stage-deadline' }, { stopped: 'stage-timeout', status: 'environment-failure', environmentFailure: true })), 'wall-clock');
  assert.equal(classifyFailure(input({ stopCause: 'work-budget', diagnostic: { category: 'budget' } }, { stopped: 'incomplete', incomplete: { cause: 'wall-clock' } })), 'wall-clock');
  assert.equal(classifyFailure(input({ stopCause: 'token-limit' })), 'token-limit');
  assert.equal(classifyFailure(input({ stopCause: 'work-budget' }, { stopped: 'incomplete', incomplete: { cause: 'output-tokens' } })), 'token-limit');
  assert.equal(classifyFailure(input({ stopCause: 'work-budget' }, { stopped: 'incomplete', incomplete: { cause: 'requests' } })), 'request-limit');
  assert.equal(classifyFailure(input({ stopCause: 'no-progress' })), 'request-limit');
});

test('ревью: отклонено, остановлено, не состоялось — по статусу ревью, а не по тексту', () => {
  const plan = (reviewStatus: 'pending' | 'rejected' | 'stale' | 'stalled') =>
    input({ stage: 'plan', note: 'произвольный текст', failure: { kind: 'plan', origin: 'plan', retryStage: 'plan', reason: 'r', reviewStatus } });
  assert.equal(classifyFailure(plan('rejected')), 'review-rejected');
  assert.equal(classifyFailure(plan('stalled')), 'review-stalled');
  assert.equal(classifyFailure(plan('pending')), 'review-failed');
  assert.equal(classifyFailure(plan('stale')), 'review-failed');
  assert.equal(classifyFailure(input({ stage: 'intent', failure: { kind: 'contract', origin: 'intent', retryStage: 'intent', reason: 'r', reviewStatus: 'rejected' } })), 'review-rejected');
  assert.equal(classifyFailure(input({ stage: 'intent', failure: { kind: 'contract', origin: 'intent', retryStage: 'intent', reason: 'r', pendingFields: 1 } })), 'contract');
});

test('формат против схемы против содержания', () => {
  const operation = { kind: 'operation' as const, origin: 'chunk' as const, retryStage: 'chunk' as const, reason: 'r' };
  assert.equal(classifyFailure(input({ failure: operation }, { failures: { operation: 1, format: 4 } })), 'format');
  assert.equal(classifyFailure(input({ failure: operation }, { failures: { operation: 1, schema: 3, format: 1 } })), 'schema');
  assert.equal(classifyFailure(input({ failure: operation }, { failures: { operation: 1 } })), 'semantic');
  assert.equal(classifyFailure(input({ stage: 'plan', failure: { kind: 'plan', origin: 'plan', retryStage: 'plan', reason: 'карта разошлась' } })), 'semantic');
  assert.equal(classifyFailure(input({ failure: { kind: 'checks', origin: 'chunk', retryStage: 'chunk', reason: 'инварианты' } })), 'semantic');
  assert.equal(classifyFailure(input({ stopCause: 'schema' })), 'schema');
  assert.equal(classifyFailure(input({ diagnostic: { category: 'invalid-response' } }, { failures: { format: 2 } })), 'format');
  assert.equal(classifyFailure(input({ diagnostic: { category: 'invalid-response' } }, { failures: { schema: 2 } })), 'schema');
  assert.equal(classifyFailure(input({ diagnostic: { category: 'human-required' } })), 'human-required');
  assert.equal(classifyFailure(input({ diagnostic: { category: 'context-required' } })), 'harness');
  assert.equal(classifyFailure(input({ stage: 'verify', ok: false, note: 'гейты красные' })), 'contract');
  assert.equal(classifyFailure(input({ stage: 'verify', ok: false, note: 'Scope: пути плана без правок' }, { stopped: 'escalate' })), 'contract');
  assert.equal(classifyFailure(input(null, { stopped: 'escalate' })), 'contract');
  assert.equal(classifyFailure(input({ diagnostic: { category: 'unassessed' } })), 'unknown');
});

test('сдвиг классов между прогонами по ключу клетки', () => {
  const rows = compareFailureClasses(
    [{ key: 'a|t|1', failureClass: 'schema' }, { key: 'b|t|1', failureClass: 'format' }, { key: 'c|t|1', failureClass: 'none' }],
    [{ key: 'a|t|1', failureClass: 'format' }, { key: 'b|t|1', failureClass: 'format' }],
  );
  assert.deepEqual(rows, [
    { key: 'a|t|1', from: 'format', to: 'schema', changed: true },
    { key: 'b|t|1', from: 'format', to: 'format', changed: false },
    { key: 'c|t|1', from: null, to: 'none', changed: false },
  ]);
});
