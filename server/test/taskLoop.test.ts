import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import type { ChatProvider, ChatRequest, ChatTurn } from '../src/provider/ChatProvider.ts';
import { ProviderEnvError } from '../src/provider/ChatProvider.ts';
import {
  CHECK_LATENCY_FLOOR_MS, failingCheckFingerprint, TaskLoopExecutor,
  type TaskLoopEvent, type TaskLoopRequest,
} from '../src/exec/TaskLoopExecutor.ts';
import { askHumanRuntimeReply, matchesExecutableTestShape, proposedPaths } from '../src/exec/taskLoopAsk.ts';

const tool = (name: string, args: Record<string, unknown> = {}): ChatTurn => ({ text: '', toolCalls: [{ id: crypto.randomUUID(), name, arguments: args, rawArguments: JSON.stringify(args) }], finishReason: 'tool_use', usage: emptyUsage() });
const done = (): ChatTurn => ({ text: 'Done', toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() });
const check = () => tool('mcp__task__check');
test('requirements use current registered evidence, not baseline or model claims', async () => {
  const f = setup([check(), done()], { structuredFeedback: true });
  f.request.contract.requirements = [
    { id: 'behavior', description: 'Keep the public behavior', source: 'human task', checks: ['project'] },
    { id: 'review', description: 'Review usability', source: 'human task', checks: [] },
  ];
  const result = await f.run();
  assert.deepEqual(result.requirements.map(r => r.status), ['verified', 'unverified']);
  assert.ok(f.events.some(e => e.kind === 'requirement_evidence'));
});
test('new behavior checks may fail initially without failing baseline and feed repair', async () => {
  const f = setup([check(), tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }), check(), done()], { structuredFeedback: true });
  f.request.checks = [...f.request.checks, { name: 'requested', baseline: false,
    run: async () => ({ passed: readFileSync(join(f.root, 'lib/value.txt'), 'utf8') === 'after', output: 'Expected after' }) }];
  f.request.contract.requirements = [{ id: 'value', description: 'Change value', source: 'task', checks: ['requested'] }];
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.requirements[0]?.status, 'verified');
  assert.equal(result.checks.filter(c => c.baseline).length, 1);
  assert.ok(result.checks.some(c => c.name === 'requested' && !c.passed));
});
test('external edits invalidate requirement evidence', async () => {
  const f = setup([check(), async () => { writeFileSync(join(f.root, 'lib/value.txt'), 'changed'); return done(); }, done(), done()]);
  f.request.contract.requirements = [{ id: 'value', description: 'Check value', source: 'task', checks: ['project'] }];
  assert.equal((await f.run()).requirements[0]?.status, 'unverified');
});
test('unknown requirement check is rejected before provider execution', async () => {
  const f = setup([]);
  f.request.contract.requirements = [{ id: 'value', description: 'Check value', source: 'task', checks: ['invented'] }];
  await assert.rejects(f.run, /registered check bindings/);
});
test('optional stagnation limit stops identical failures without edits', async () => {
  const f = setup([check(), tool('Read', { file_path: 'lib/value.txt' }), check(), done()], { maxUnchangedFailures: 2 });
  f.request.checks = [...f.request.checks, { name: 'feature', baseline: false, run: async () => ({ passed: false, output: 'same failure' }) }];
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.match(result.reason, /Repeated identical/);
  assert.equal(result.metrics.modelRequests, 3);
});
test('optional repeated-error limit stops identical tool failures', async () => {
  // Distinct arguments so LoopExecutor executes each deny (identical args collapse to «повторный вызов»
  // and its own consecutive-call stop). Same policy reason still fingerprints as a repeated error.
  const f = setup([
    tool('Write', { file_path: '../out.txt', content: '1' }),
    tool('Write', { file_path: '../out.txt', content: '2' }),
    tool('Write', { file_path: '../out.txt', content: '3' }),
    done(),
  ], { maxRepeatedErrors: 2 });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Repeated identical tool errors/);
  assert.ok(result.metrics.repeatedErrors >= 2);
});
test('hung registered check fails by executor timeout instead of hanging forever', async () => {
  const f = setup([check(), done()], {
    checks: [{ name: 'project', run: async signal => {
      await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return { passed: true, output: 'unreachable' };
    } }],
  });
  const result = await f.run();
  assert.equal(result.status, 'environment_error');
  assert.equal(result.metrics.modelRequests, 0);
  assert.ok(result.checks.some(c => /timed out/i.test(c.output)));
});
test('failing check fingerprint ignores TAP summary noise', () => {
  const a = failingCheckFingerprint('test', '# tests 1\nnot ok 1 - H2 [behavior] case\n# pass 0\n');
  const b = failingCheckFingerprint('test', '# tests 1\nnot ok 1 - H2 [behavior] case\n# fail 1\n');
  assert.equal(a, b);
});
test('post-baseline check slower than latency budget fails as repairable FAIL', async () => {
  let calls = 0;
  let turn = 0;
  const root = mkdtempSync(join(tmpdir(), 'task-loop-latency-'));
  mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'lib/value.txt'), 'before'); writeFileSync(join(root, 'tests/trusted.txt'), 'protected');
  const executor = new TaskLoopExecutor({
    provider: { name: 'fake', chat: async () => { turn++; return turn === 1 ? check() : done(); } },
    maxResultBytes: 12000, readRangeRequiredAboveBytes: 12000,
    bashTimeoutMs: CHECK_LATENCY_FLOOR_MS + 4000, temperature: 0,
  });
  const result = await executor.run({
    cwd: root, model: 'fake',
    contract: { task: 'Keep green checks fast', writable: ['lib/'], protected: ['tests/trusted.txt'] },
    checks: [{ name: 'project', run: async () => {
      calls++;
      if (calls === 1) return { passed: true, output: 'baseline fast' };
      await new Promise(resolve => setTimeout(resolve, CHECK_LATENCY_FLOOR_MS + 200));
      return { passed: true, output: 'slow but green assertions' };
    } }],
    maxTurns: 4, activeTimeoutMs: 30000, maxCost: null, signal: new AbortController().signal,
    ask: async () => ({}),
  });
  assert.notEqual(result.status, 'ready_for_review');
  assert.ok(result.checks.some(c => !c.baseline && /Latency budget exceeded/i.test(c.output)));
});
function setup(turns: (ChatTurn | ((request: ChatRequest) => Promise<ChatTurn>))[], overrides: Partial<TaskLoopRequest> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-loop-test-'));
  mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'lib/value.txt'), 'before'); writeFileSync(join(root, 'tests/trusted.txt'), 'protected');
  const events: TaskLoopEvent[] = [];
  const provider: ChatProvider = { name: 'fake', chat: async req => { const next = turns.shift() ?? done(); return typeof next === 'function' ? next(req) : next; } };
  const executor = new TaskLoopExecutor({ provider, maxResultBytes: 12000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000, temperature: 0 });
  const request: TaskLoopRequest = { cwd: root, model: 'fake', contract: { task: 'Update the value; keep the trusted test.', writable: ['lib/', 'tests/'], protected: ['tests/trusted.txt'] },
    checks: [{ name: 'project', run: async () => ({ passed: true, output: 'real callback ran' }) }],
    maxTurns: 8, activeTimeoutMs: 10000, maxCost: null, signal: new AbortController().signal,
    ask: async () => ({}), emit: event => events.push(event), ...overrides };
  return { root, events, request, run: () => executor.run(request) };
}
test('plain done is rejected without post-baseline checks', async () => {
  const f = setup([done(), done(), done()]); const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.checks.length, 1);
});
test('read/edit/check/finalize shares history and records real evidence', async () => {
  const f = setup([tool('Read', { file_path: 'lib/value.txt' }), tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }), check(), done()]);
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.equal(readFileSync(join(f.root, 'lib/value.txt'), 'utf8'), 'after');
  assert.equal(result.metrics.writes, 1); assert.equal(result.metrics.modelRequests, 4);
  assert.ok(f.events.some(e => e.kind === 'model_request')); assert.ok(f.events.some(e => e.kind === 'execution'));
  assert.equal((f.events.find(e => e.kind === 'model_request')?.payload as { temperature: number }).temperature, 0);
});
test('edits invalidate earlier checks, including external edits', async () => {
  const f = setup([check(), async () => { writeFileSync(join(f.root, 'lib/value.txt'), 'external'); return done(); }, done(), done()]);
  assert.equal((await f.run()).status, 'failed');
});
test('protected tests, outside paths, and arbitrary shell are denied before execution', async () => {
  const f = setup([tool('Write', { file_path: 'tests/trusted.txt', content: 'tampered' }), tool('Write', { file_path: '../escape.txt', content: 'tampered' }), tool('Bash', { command: 'echo bypass' }), done()]);
  const result = await f.run();
  assert.equal(result.metrics.denied, 3);
  assert.equal(readFileSync(join(f.root, 'tests/trusted.txt'), 'utf8'), 'protected');
  assert.notEqual(result.status, 'ready_for_review');
});
test('missing human answer stops with needs_input and never fabricates success', async () => {
  const f = setup([tool('AskHuman', { questions: [{ id: 'q', header: 'Fact', question: 'What is the agreed coefficient?', options: [], multiSelect: false }] }), check(), done()]);
  assert.equal((await f.run()).status, 'needs_input');
});
test('unanswered AskHuman after green checks does not block ready_for_review', async () => {
  const f = setup([
    check(),
    tool('AskHuman', { questions: [{ id: 'q', header: 'Speculation', question: 'Prefer TypeError or RangeError outside the contract?', options: [], multiSelect: false }] }),
    done(),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.ok(f.events.some(e => e.kind === 'warning'));
});
test('failed check feeds back to repair and then fresh checks pass', async () => {
  let calls = 0;
  const f = setup([check(), tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }), check(), done()],
    { checks: [{ name: 'project', run: async () => ({ passed: ++calls !== 2, output: calls === 2 ? 'assertion failed' : 'passed' }) }] });
  const result = await f.run(); assert.equal(result.status, 'ready_for_review', result.reason); assert.equal(result.metrics.repairs, 1);
});
test('baseline environment failure does not call the model', async () => {
  const f = setup([done()], { checks: [{ name: 'project', run: async () => ({ passed: false, output: 'missing runtime', environmentError: 'missing runtime' }) }] });
  const result = await f.run(); assert.equal(result.status, 'environment_error'); assert.equal(result.metrics.modelRequests, 0);
});
test('active deadline aborts an in-flight request', async () => {
  let aborted = false;
  const f = setup([req => new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => { aborted = true; reject(req.signal.reason); }))], { activeTimeoutMs: 40 });
  const result = await f.run(); assert.equal(result.status, 'budget_exhausted'); assert.equal(aborted, true);
});
test('operator cancellation differs from budget exhaustion', async () => {
  const controller = new AbortController();
  const f = setup([async () => { controller.abort(); throw new Error('cancel'); }], { signal: controller.signal });
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.reason, /Cancelled/);
});
test('provider outage is an environment error', async () => {
  // Always-throwing provider: retries re-enter chat() and must not pull a later done() turn.
  const root = mkdtempSync(join(tmpdir(), 'task-loop-outage-'));
  mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'lib/value.txt'), 'before'); writeFileSync(join(root, 'tests/trusted.txt'), 'protected');
  const executor = new TaskLoopExecutor({
    provider: { name: 'offline', chat: async () => { throw new ProviderEnvError('offline'); } },
    maxResultBytes: 12000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000, temperature: 0,
  });
  const result = await executor.run({
    cwd: root, model: 'fake',
    contract: { task: 'Keep green', writable: ['lib/'], protected: ['tests/trusted.txt'] },
    checks: [{ name: 'project', run: async () => ({ passed: true, output: 'ok' }) }],
    maxTurns: 8, activeTimeoutMs: 10000, maxCost: null, signal: new AbortController().signal, ask: async () => ({}),
  });
  assert.equal(result.status, 'environment_error', result.reason);
  assert.equal(result.usage.costUsd, null, 'A request without returned usage must not be reported as free');
});
test('turn limit is explicit', async () => {
  const f = setup([tool('Read', { file_path: 'lib/value.txt' })], { maxTurns: 1 });
  assert.equal((await f.run()).status, 'budget_exhausted');
});
test('unknown paid cost stops further requests and stays unknown in the report', async () => {
  const response = check(); response.usage.costUsd = null;
  const f = setup([response, done()], { maxCost: 1 });
  const result = await f.run(); assert.equal(result.status, 'budget_exhausted'); assert.equal(result.usage.costUsd, null);
});
test('waiting for a human pauses the active deadline', async () => {
  const f = setup([tool('AskHuman', { questions: [{ header: 'Rule', question: 'What missing rule applies?', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }], multiSelect: false }] }), check(), done()],
    { activeTimeoutMs: 100, ask: async questions => { await new Promise(resolve => setTimeout(resolve, 150)); return Object.fromEntries(questions.map(q => [q.id, ['Use A']])); } });
  const result = await f.run(); assert.equal(result.status, 'ready_for_review', result.reason); assert.ok(result.metrics.humanWaitMs >= 140);
});
test('operator can cancel even a human adapter that never resolves', async () => {
  const controller = new AbortController();
  const f = setup([tool('AskHuman', { questions: [{ header: 'Rule', question: 'What missing rule applies?', options: [], multiSelect: false }] })],
    { signal: controller.signal, ask: () => { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); } });
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.reason, /Cancelled/);
});
test('modified files during a check cannot receive fresh evidence', async () => {
  let calls = 0;
  const f = setup([check(), done(), done(), done()]);
  f.request.checks = [{ name: 'project', run: async () => { if (++calls > 1) writeFileSync(join(f.root, 'lib/generated.txt'), String(calls)); return { passed: true, output: 'passed but mutated' }; } }];
  assert.equal((await f.run()).status, 'failed');
});
test('a saved write with failed import diagnostics is counted before repair', async () => {
  const f = setup([
    check(),
    tool('Write', { file_path: 'lib/consumer.ts', content: "import { absent } from './exports.ts';\nexport const answer = absent;\n" }),
    done(),
    tool('Edit', { file_path: 'lib/consumer.ts', old_string: 'absent', new_string: 'present', replace_all: true }),
    check(), done(),
  ]);
  writeFileSync(join(f.root, 'lib/exports.ts'), 'export const present = 1;\n');
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.equal(result.metrics.writes, 2, 'Both the failed-diagnostic write and its repair changed disk');
  assert.equal(result.metrics.modelRequests, 6, 'A failed-diagnostic write invalidated the earlier passing check');
  assert.ok(f.events.some(e => e.kind === 'tool_result' && (e.payload as { ok: boolean }).ok === false));
  const writes = f.events.filter(e => e.kind === 'implementation_write');
  assert.equal((writes[0]?.payload as { toolOk: boolean }).toolOk, false);
  assert.equal((writes[1]?.payload as { toolOk: boolean }).toolOk, true);
  assert.ok(result.metrics.firstEditMs !== null && result.metrics.firstEditMs <= writes[0]!.elapsedMs);
});
test('AskHuman proposing paths outside writable is answered by runtime without needs_input', async () => {
  const f = setup([
    tool('AskHuman', { questions: [{ id: 'q', header: 'examples', question: 'Should I create an examples/ directory for public-api?', options: [{ label: 'Yes, create examples/', description: 'Add examples/demo.mjs' }, { label: 'No', description: 'Skip' }], multiSelect: false }] }),
    check(), done(),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.ok(f.events.some(e => e.kind === 'warning' && /write boundaries/i.test(String((e.payload as { text: string }).text))));
  assert.ok(f.events.some(e => e.kind === 'human_answer' && (e.payload as { source?: string }).source === 'runtime'));
});
test('AskHuman about harness internals is answered by runtime without needs_input', async () => {
  const f = setup([
    tool('AskHuman', { questions: [{ id: 'q', header: 'harness', question: 'bench/checks/evidence/option-overlay.visible.mjs looks harness-side broken; what inputs does public-api expect?', options: [], multiSelect: false }] }),
    check(), done(),
  ]);
  assert.equal((await f.run()).status, 'ready_for_review');
});
test('finish requires a new test file when requireAdditionalTestsUnder is set', async () => {
  const blocked = setup([
    tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }),
    check(), done(), done(),
  ]);
  blocked.request.contract.requireAdditionalTestsUnder = ['tests/'];
  assert.notEqual((await blocked.run()).status, 'ready_for_review');

  const ok = setup([
    tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }),
    tool('Write', { file_path: 'tests/new-behavior.test.txt', content: 'covers after\n' }),
    check(), done(),
  ]);
  ok.request.contract.requireAdditionalTestsUnder = ['tests/'];
  assert.equal((await ok.run()).status, 'ready_for_review');
});
test('finish rejects a new test file with the wrong extension versus the seed suite', async () => {
  const f = setup([
    tool('Edit', { file_path: 'lib/value.txt', old_string: 'before', new_string: 'after' }),
    tool('Write', { file_path: 'tests/extra.test.js', content: 'export {};\n' }),
    check(), done(), done(),
  ]);
  writeFileSync(join(f.root, 'tests/seed.test.mjs'), 'export {};\n');
  f.request.contract.requireAdditionalTestsUnder = ['tests/'];
  f.request.contract.protected = ['tests/trusted.txt', 'tests/seed.test.mjs'];
  assert.notEqual((await f.run()).status, 'ready_for_review');
});
test('AskHuman restating contract behavior is answered by runtime without needs_input', async () => {
  const f = setup([
    tool('AskHuman', { questions: [{
      id: 'q', header: 'APIReq',
      question: 'What should be the expected behavior of mergeRanges for input [[1, 2], [2, 3]]?',
      options: [{ label: 'Merge', description: 'Return [[1, 3]]' }, { label: 'Keep', description: 'Return [[1, 2], [2, 3]]' }],
      multiSelect: false,
    }] }),
    check(), done(),
  ]);
  f.request.contract.task = 'Export mergeRanges. Overlapping or touching ranges merge. Empty input returns [].';
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.ok(f.events.some(e => e.kind === 'human_answer' && (e.payload as { source?: string }).source === 'runtime'));
  assert.ok(!f.events.some(e => e.kind === 'stop' && (e.payload as { status?: string }).status === 'needs_input'));
});
test('AskHuman meta-review is answered by runtime and does not call the bank', async () => {
  let asked = 0;
  const f = setup([
    check(),
    tool('AskHuman', { questions: [{
      id: 'q', header: 'Facts',
      question: 'Does the csvRow implementation satisfy all the requirements?',
      options: [{ label: 'Yes', description: 'All cases handled' }], multiSelect: false,
    }] }),
    done(),
  ], { ask: async () => { asked++; return {}; } });
  const result = await f.run();
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.equal(asked, 0, 'meta-review must not hit the human/bank adapter');
  assert.ok(f.events.some(e => e.kind === 'human_answer' && (e.payload as { source?: string }).source === 'runtime'));
});
test('ProviderEnvError is retried before becoming environment_error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-loop-retry-'));
  mkdirSync(join(root, 'lib')); mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'lib/value.txt'), 'before'); writeFileSync(join(root, 'tests/trusted.txt'), 'protected');
  const events: TaskLoopEvent[] = [];
  let turn = 0;
  const executor = new TaskLoopExecutor({
    provider: {
      name: 'flaky',
      chat: async () => {
        turn++;
        if (turn === 1) throw new ProviderEnvError('intermittent 500');
        if (turn === 2) return check();
        return done();
      },
    },
    maxResultBytes: 12000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000, temperature: 0,
  });
  const result = await executor.run({
    cwd: root, model: 'fake',
    contract: { task: 'Keep green', writable: ['lib/'], protected: ['tests/trusted.txt'] },
    checks: [{ name: 'project', run: async () => ({ passed: true, output: 'ok' }) }],
    maxTurns: 8, activeTimeoutMs: 10000, maxCost: null, signal: new AbortController().signal,
    ask: async () => ({}), emit: event => events.push(event),
  });
  assert.equal(result.status, 'ready_for_review', result.reason);
  assert.ok(events.some(e => e.kind === 'warning' && /ProviderEnvError retry/i.test(String((e.payload as { text: string }).text))));
});
test('proposedPaths extracts relative directory proposals', () => {
  assert.ok(proposedPaths('create examples/demo.mjs please').includes('examples/'));
  assert.equal(askHumanRuntimeReply([{
    id: 'q', header: 'x', question: 'Create docs/overview.md outside writable?', options: [], multiSelect: false,
  }], ['src/', 'test/'])?.includes('docs/'), true);
});
test('matchesExecutableTestShape requires seed extension and test infix when seeds use them', () => {
  assert.equal(matchesExecutableTestShape('test/csvRow.test.js', ['test/csv.test.mjs']), false);
  assert.equal(matchesExecutableTestShape('test/csvRow.test.mjs', ['test/csv.test.mjs']), true);
  assert.equal(matchesExecutableTestShape('tests/extra.txt', ['tests/trusted.txt']), true);
});
