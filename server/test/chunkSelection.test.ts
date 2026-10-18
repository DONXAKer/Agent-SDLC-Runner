import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { GuidedExecutor } from '../src/exec/GuidedExecutor.ts';
import { initGuided, readGuided } from '../src/run/guidedState.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

for (const scenario of ['select', 'duplicate', 'order_bias', 'reject_all', 'unknown', 'invalid_id', 'invalid_ops',
  'changed_source', 'changed_dependency', 'denied', 'changed_approval', 'changed_approval_dependency', 'cost', 'judge_cost', 'turns', 'remaining_groups',
  'context', 'no_change', 'timeout', 'timeout_ignored', 'check_failed', 'two_groups', 'drafts', 'v4', 'cancelled', 'split', 'new_file', 'new_file_failed', 'resume', 'needs_research', 'search', 'known_read', 'redirected_read'] as const) {
  test(`Chunk arbitration: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'chunk-selection-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const paths = new WitokPaths(root, 'case'); initGuided(paths, 'local:test', scenario === 'v4' ? 4 : 1);
    const before = 'function count() { return 1; }\n';
    writeFileSync(join(root, 'counter.ts'), before); writeFileSync(join(root, 'other.ts'), before);
    let generated = 0; let judged = 0; let writes = 0; let checks = 0; let usageEvents = 0; let reviews = 0;
    const controller = new AbortController();
    const reply = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const,
      usage: scenario === 'cost' ? { ...emptyUsage(), costUsd: 0.6 } : emptyUsage() });
    const generator: ChatProvider = { name: 'test', chat: async request => {
      generated++;
      const input = JSON.parse(request.messages[1]!.content);
      if (scenario === 'needs_research') return reply({ action: 'read', path: 'other.ts', offset: 1, limit: 10 });
      if (scenario === 'search') return reply({ action: 'search', pattern: 'count' });
      if ((scenario === 'known_read' || scenario === 'redirected_read') && generated === 1) return reply({ action: 'read', path: 'counter.ts', offset: 1, limit: 10 });
      if (scenario === 'timeout_ignored') await new Promise(done => setTimeout(done, 200));
      if (scenario === 'split' && generated === 1) return reply({ action: 'split', parts: [
        { title: 'left', files: ['counter.ts'], prediction: 'two' }, { title: 'right', files: ['other.ts'], prediction: 'two' },
      ] });
      assert.equal(runInNewContext(readFileSync(join(root, 'counter.ts'), 'utf8') + '\ncount()'), judged >= 2 && scenario !== 'new_file' && scenario !== 'new_file_failed' ? 2 : 1);
      if (scenario === 'timeout') {
        await new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('test provider deadline')), 500);
          request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(request.signal.reason); }, { once: true });
        });
      }
      if (scenario === 'no_change') return reply({ action: 'no_change', reason: 'Current behavior satisfies the requirement' });
      const value = scenario === 'duplicate' ? 2 : scenario === 'drafts' ? generated <= 2 ? 2 : 3 : (generated - (scenario === 'invalid_ops' || scenario === 'split' || scenario === 'known_read' ? 1 : 0)) % 2 ? 2 : 3;
      if (scenario === 'new_file' || scenario === 'new_file_failed') return reply({ action: 'patch', prediction: 'value returns two',
        ops: [{ op: 'create_file', file: 'feature.ts', body: `function value() { return ${value}; }` }] });
      const file = scenario === 'two_groups' && judged >= 2 ? 'other.ts' : scenario === 'drafts' ? input.activePart.files[0] : 'counter.ts';
      const op = { op: 'replace_body', file, symbol: scenario === 'invalid_ops' && generated === 1 ? 'missing' : 'count',
        body: `return ${value};` };
      if (scenario === 'v4') { delete (op as { file?: string }).file; if (input.targetSymbol) delete (op as { symbol?: string }).symbol; }
      return reply({ action: 'patch', prediction: 'updated count', ops: scenario === 'split' ? [op, { ...op, file: 'other.ts' }] : [op] });
    } };
    const judge: ChatProvider = { name: 'test', chat: async request => {
      judged++;
      if (scenario === 'cancelled') controller.abort();
      const input = JSON.parse(request.messages[1]!.content);
      const ids = input.candidates.map((c: { id: string }) => c.id);
      assert.equal(readGuided(paths)!.transaction, undefined, 'no candidate can create a WAL');
      if (scenario === 'new_file' || scenario === 'new_file_failed') assert.equal(existsSync(join(root, 'feature.ts')), false);
      assert.equal(request.tools.length, 0);
      if (scenario === 'changed_source') writeFileSync(join(root, 'counter.ts'), '// external\n');
      if (scenario === 'changed_dependency') writeFileSync(join(root, 'other.ts'), '// external\n');
      if (scenario === 'reject_all' || scenario === 'unknown') return reply({ selected: null,
        outcome: scenario === 'unknown' ? 'insufficient_evidence' : scenario, reason: 'not justified' });
      const value = reply({ selected: scenario === 'invalid_id' ? 'missing' : scenario === 'order_bias' ? ids[0] : 'candidate-1',
        outcome: 'select', reason: 'meets contract' });
      return scenario === 'judge_cost' ? { ...value, usage: { ...emptyUsage(), costUsd: 0.6 } } : value;
    } };
    const hooks: ExecHooks = { onText() {}, onThinking() {}, onWarn() {}, onFriction() {}, onToolResult() {},
      onRecord: () => '', onAskHuman: async () => ({}), onUsage: (_usage, _duration, work) => { usageEvents++; if (work?.purpose === 'review') reviews++; },
      onToolRequest: async call => {
        if (call.kind === 'read') return { allowed: true, by: 'policy', updatedInput: scenario === 'redirected_read' ? { file_path: join(root, 'other.ts'), offset: 1, limit: 10 } : null };
        writes++; assert.equal(judged % 2, 0);
        if (scenario === 'changed_approval') writeFileSync(join(root, 'counter.ts'), '// external\n');
        if (scenario === 'changed_approval_dependency') writeFileSync(join(root, 'other.ts'), '// external\n');
        return scenario === 'denied' ? { allowed: false, reason: 'denied', updatedInput: null, by: 'policy' } : { allowed: true, updatedInput: null, by: 'policy' };
      } };
    const req: ExecRequest = { cwd: root, model: 'generator', signal: controller.signal,
      maxTurns: scenario === 'turns' ? 3 : scenario === 'remaining_groups' ? 6 : scenario === 'check_failed' || scenario === 'new_file_failed' ? 4 : 30,
      maxBudgetUsd: scenario === 'cost' || scenario === 'judge_cost' ? 1 : null,
      allowedTools: ['Read', 'Write', 'Edit'], readOnlyDirs: [], subagents: [], mcp: null,
      prompt: { system: '', user: '', guidedProtocol: true } as ExecRequest['prompt'], finishGuard: null, salvageFromText: null,
      ...(scenario === 'v4' ? { guidedEngineVersion: 4 as const } : {}) };
    const item = (id: string, files: string[]) => ({ id, files, claims: ['claim-1'], title: 'adjust count', prediction: 'returns two',
      checks: ['check count'], dependsOn: [], status: 'pending' as const, attempts: 0, repartitioned: false });
    const items = scenario === 'two_groups' || scenario === 'remaining_groups' ? [item('a', ['counter.ts']), item('b', ['other.ts'])] :
      [item('a', scenario === 'new_file' || scenario === 'new_file_failed' ? ['feature.ts'] : scenario === 'drafts' || scenario === 'split' ? ['counter.ts', 'other.ts'] : ['counter.ts'])];
    if (scenario === 'split') items[0]!.repartitioned = true;
    const executor = new GuidedExecutor({ paths, provider: generator, items, inputRevision: () => 'fixed',
      requirements: 'count must return two', sources: 'explicit test contract', contextWindow: 32768,
      ...(scenario === 'changed_dependency' || scenario === 'changed_approval_dependency' ? { selectionSources: ['other.ts'] } : {}),
      draftPerFile: scenario === 'drafts',
      chunkSelection: { candidates: 2, candidateTimeoutMs: scenario === 'timeout' || scenario === 'timeout_ignored' ? 100 : 60000,
        judge: { provider: judge, model: 'judge', params: null, contextWindow: scenario === 'context' ? 10 : 32768 } },
      check: async () => { checks++; return { passed: scenario !== 'check_failed' && scenario !== 'new_file_failed', result: 'count checked' }; },
    });
    const result = await executor.run(req, hooks);
    const success = ['select', 'duplicate', 'no_change', 'two_groups', 'drafts', 'v4', 'invalid_ops', 'split', 'new_file', 'resume', 'known_read'].includes(scenario);
    assert.equal(result.ok, success, result.note);
    assert.equal(result.modelRequests, generated + judged - (scenario === 'timeout' && generated > 0 ? 1 : 0));
    assert.equal(usageEvents, result.modelRequests);
    assert.equal(reviews, judged);
    assert.ok((result.modelRequests ?? 0) <= req.maxTurns);
    if (success) {
      assert.equal(checks, items.length);
      assert.equal(runInNewContext(readFileSync(join(root, 'counter.ts'), 'utf8') + '\ncount()'), scenario === 'no_change' || scenario === 'new_file' ? 1 : 2);
      if (scenario === 'new_file') assert.equal(runInNewContext(readFileSync(join(root, 'feature.ts'), 'utf8') + '\nvalue()'), 2);
      assert.equal(readGuided(paths)!.transaction, undefined);
      if (scenario === 'split') assert.equal(runInNewContext(readFileSync(join(root, 'other.ts'), 'utf8') + '\ncount()'), 2);
    } else if (scenario !== 'changed_source' && scenario !== 'changed_approval') {
      assert.equal(readFileSync(join(root, 'counter.ts'), 'utf8'), before);
    } else assert.equal(readFileSync(join(root, 'counter.ts'), 'utf8'), '// external\n');
    if (scenario === 'new_file_failed') assert.equal(existsSync(join(root, 'feature.ts')), false);
    if (!success && !['check_failed', 'denied', 'changed_approval', 'changed_approval_dependency', 'new_file_failed'].includes(scenario)) assert.equal(writes, 0);
    const audits = readdirSync(join(paths.runnerDir, 'chunk-selection')).map(file => JSON.parse(readFileSync(join(paths.runnerDir, 'chunk-selection', file), 'utf8')));
    assert.ok(audits.length > 0);
    if (success) assert.ok(audits.every(a => a.status === 'complete'));
    if (!success) assert.equal(result.failure?.origin, scenario === 'needs_research' || scenario === 'search' || scenario === 'redirected_read' ? 'explore' : 'chunk');
    if (scenario === 'resume') {
      const beforeCalls = generated + judged;
      const resumed = await executor.run(req, hooks);
      assert.equal(resumed.ok, true, resumed.note);
      assert.equal(resumed.modelRequests, 0);
      assert.equal(generated + judged, beforeCalls);
      assert.equal(checks, 2);
    }
  });
}

test('selected rename includes runtime-updated dependent imports without applying losing variants', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chunk-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = new WitokPaths(root, 'case'); initGuided(paths, 'local:test');
  const producer = 'export function total() { return 1; }\n';
  const consumer = "import { total } from './calc.ts';\nexport const result = total();\n";
  writeFileSync(join(root, 'calc.ts'), producer); writeFileSync(join(root, 'view.ts'), consumer);
  let samples = 0; let judgments = 0;
  const answer = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const, usage: emptyUsage() });
  const generator: ChatProvider = { name: 'test', chat: async () => {
    assert.equal(readFileSync(join(root, 'calc.ts'), 'utf8'), producer);
    assert.equal(readFileSync(join(root, 'view.ts'), 'utf8'), consumer);
    return answer({ action: 'patch', prediction: 'rename across consumers', ops: [{ op: 'rename', file: 'calc.ts', symbol: 'total', newName: ++samples === 1 ? 'sum' : 'amount' }] });
  } };
  const judge: ChatProvider = { name: 'test', chat: async request => {
    judgments++;
    const input = JSON.parse(request.messages[1]!.content);
    assert.equal(input.candidates[0].changes.length, 2);
    assert.equal(readFileSync(join(root, 'view.ts'), 'utf8'), consumer);
    return answer({ outcome: 'select', selected: 'candidate-1', reason: 'consistent rename' });
  } };
  const hooks: ExecHooks = { onText() {}, onThinking() {}, onWarn() {}, onFriction() {}, onToolResult() {}, onUsage() {},
    onAskHuman: async () => ({}), onRecord: () => '', onToolRequest: async () => {
      assert.equal(judgments, 2); return { allowed: true, by: 'policy', updatedInput: null };
    } };
  const result = await new GuidedExecutor({ paths, provider: generator, contextWindow: 32768, sources: '', requirements: 'rename total to sum', inputRevision: () => 'fixed',
    items: [{ id: 'rename', files: ['calc.ts', 'view.ts'], claims: ['claim-1'], title: 'rename total', prediction: 'imports updated',
      checks: ['imports'], status: 'pending', attempts: 0, dependsOn: [], repartitioned: false }],
    chunkSelection: { candidates: 2, judge: { provider: judge, model: 'judge', params: null, contextWindow: 32768 } },
    check: async () => ({ passed: /function sum\(/u.test(readFileSync(join(root, 'calc.ts'), 'utf8')) &&
      /import \{ sum \}/u.test(readFileSync(join(root, 'view.ts'), 'utf8')) && /result = sum\(\)/u.test(readFileSync(join(root, 'view.ts'), 'utf8')), result: 'producer and consumer agree' }),
  }).run({ cwd: root, model: 'generator', signal: new AbortController().signal, maxTurns: 20, maxBudgetUsd: null,
    prompt: { system: '', user: '' } as ExecRequest['prompt'], allowedTools: ['Edit'], readOnlyDirs: [], subagents: [], mcp: null,
    finishGuard: null, salvageFromText: null }, hooks);
  assert.equal(result.ok, true, result.note); assert.equal(samples, 2); assert.equal(judgments, 2);
});
