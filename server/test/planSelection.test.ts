import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { AXES } from '../src/artifacts/planAxes.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initializePreparation, preparation, savePreparation, sourceHash, syncCanonicalPreparation } from '../src/artifacts/preparation.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { PlanSelectionExecutor, parsePlanJudgment } from '../src/exec/PlanSelectionExecutor.ts';
import type { ExecRequest, ExecHooks } from '../src/exec/StageExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { contractDependencies } from '../src/exec/guidedContract.ts';

test('judgment must name an offered candidate and preserve the reject/unknown outcome', () => {
  assert.equal(parsePlanJudgment('{"selected":null,"outcome":"reject_all","reason":"bad"}', ['a']).selected, null);
  assert.throws(() => parsePlanJudgment('{"selected":"z","outcome":"select","reason":"good"}', ['a']));
  assert.throws(() => parsePlanJudgment('{"selected":"a","outcome":"insufficient_evidence","reason":"missing"}', ['a']));
  assert.throws(() => parsePlanJudgment('{"selected":"a","outcome":"select","reason":""}', ['a']));
});

for (const scenario of ['select', 'order_bias', 'reject_all', 'unknown', 'invalid', 'no_valid', 'changed_source', 'denied', 'budget', 'context', 'duplicate', 'other_path', 'v4'] as const) {
  test(`selection integration: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'plan-selection-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = scenario === 'other_path' ? 'engine/count.ts' : 'lib/name.ts';
    const symbol = scenario === 'other_path' ? 'adjustCount' : 'formatName';
    mkdirSync(join(root, scenario === 'other_path' ? 'engine' : 'lib'));
    const source = scenario === 'other_path' ? 'function adjustCount(value: number) { return value; }\n' : 'function formatName(value: string) { return value; }\n';
    writeFileSync(join(root, file), source);
    const paths = new WitokPaths(root, 'test');
    const requestText = scenario === 'other_path' ? 'Clamp negative counters to zero.' : 'Normalize display names.';
    initializePreparation(paths, requestText, 3);
    writeArtifact(paths.intent, `# Task\n## Что делаем\n${requestText}\n## Чего не делаем\nNo API changes.\n`);
    const state = preparation(paths)!;
    savePreparation(paths, { ...state, readEvidence: [{ path: file, sourceHash: sourceHash(source), excerptHash: sourceHash(source), stage: 'explore' }],
      canonical: { requirements: { documentHash: 'test',
        acceptance: [{ id: 'claim-1', behavior: scenario === 'other_path' ? 'negative counts become zero' : 'trim display names', procedure: `call ${symbol}`, expected: scenario === 'other_path' ? 'zero' : 'trimmed' }], basis: [],
        constraints: { inScope: [], outOfScope: [], invariants: [], assumptions: [], questions: [] } } } });
    const claim = preparation(paths)!.canonical!.requirements!.acceptance[0]!;
    writeArtifact(paths.intent, readFileSync(paths.intent, 'utf8') +
      `\n## Приёмочный лист\n| ID | Пункт | Как проверить (процедура + критерий) |\n|---|---|---|\n| ${claim.id} | ${claim.behavior} | Процедура: ${claim.procedure}. Ожидаемо: ${claim.expected} |\n` +
      `\n## Основания и сценарии\n| ID | Основание | Сценарий | Контрпример |\n|---|---|---|---|\n| claim-1 | ${requestText} | ${claim.procedure} | unchanged result |\n`);
    syncCanonicalPreparation(paths);
    let generated = 0; let judged = 0; let writes = 0; let charged = 0;
    const plan = (i: number) => ({ approach: `Use ${symbol} in ${file}; variant ${i}; copying logic elsewhere duplicates it.`,
      steps: [{ id: 1, file, isNew: false, symbol, action: scenario === 'other_path' ? 'clamp negative values' : 'trim whitespace', claims: ['claim-1'],
        check: 'call with surrounding spaces and an empty string', expected: 'trimmed name and empty string', contract: 'internal function, no public API change', dependsOn: [] }],
      excluded: [], axes: AXES.map(name => ({ name, affected: false, reason: 'internal formatting only', outcome: 'invariant: public API unchanged' })),
      changes: 'none', callers: [] });
    const reply = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const,
      usage: scenario === 'budget' ? { ...emptyUsage(), costUsd: 1 } : emptyUsage() });
    const generator: ChatProvider = { name: 'test', chat: async (request: ChatRequest) => {
      generated++;
      assert.equal(request.messages.some(m => m.content.includes('candidate-')), false, 'no peer candidates in generator context');
      assert.equal(existsSync(paths.plan), false, 'proposal generation must not write canonical plan');
      const value = plan(scenario === 'duplicate' ? 1 : generated);
      const compact = { ...value, steps: value.steps.map(({ id: _id, isNew: _isNew, ...step }) => step),
        axes: value.axes.map(({ name: _name, ...axis }) => axis) };
      const schemaName = request.params?.response_format as any;
      if (scenario === 'v4' && schemaName?.json_schema?.name === 'guided_plan_outline') return reply({
        steps: compact.steps.map(({ symbol: _symbol, action: _action, check: _check, expected: _expected, contract: _contract, ...step }) => step) });
      if (scenario === 'v4' && schemaName?.json_schema?.name === 'guided_plan_card') {
        const { file: _file, claims: _claims, dependsOn: _dependsOn, ...details } = compact.steps[0]!;
        return reply(details);
      }
      if (scenario === 'v4' && schemaName?.json_schema?.name === 'guided_plan_remainder') {
        const { steps: _steps, ...remainder } = compact;
        return reply(remainder);
      }
      return reply(scenario === 'no_valid' ? {} : scenario === 'v4' ? compact : value);
    } };
    const judge: ChatProvider = { name: 'test', chat: async request => {
      judged++;
      assert.equal(existsSync(paths.plan), false);
      assert.equal(request.tools.length, 0);
      const payload = JSON.parse(request.messages[1]!.content);
      assert.equal(payload.input.sources[0].content, source);
      const ids = payload.candidates.map((c: { id: string }) => c.id);
      if (scenario !== 'duplicate') assert.deepEqual(ids, judged === 1 ? ['candidate-1', 'candidate-2', 'candidate-3'] : ['candidate-3', 'candidate-2', 'candidate-1']);
      if (scenario === 'changed_source') writeFileSync(join(root, 'lib/name.ts'), source + '// external change');
      if (scenario === 'invalid') return reply({ selected: 'candidate-99', outcome: 'select', reason: 'invented' });
      if (scenario === 'reject_all' || scenario === 'unknown') return reply({ selected: null,
        outcome: scenario === 'unknown' ? 'insufficient_evidence' : scenario, reason: 'not enough' });
      return reply({ selected: scenario === 'duplicate' ? 'candidate-1' : scenario === 'order_bias' ? ids[0] : 'candidate-2', outcome: 'select', reason: 'requirements covered' });
    } };
    const hooks: ExecHooks = { onText() {}, onThinking() {}, onWarn() {}, onFriction() {}, onToolResult() {}, onRecord: () => '',
      onAskHuman: async () => ({}), onUsage: () => { charged++; }, onToolRequest: async () => {
        writes++;
        return scenario === 'denied' ? { allowed: false, reason: 'denied', by: 'policy', updatedInput: null } : { allowed: true, by: 'policy', updatedInput: null };
      } };
    const req: ExecRequest = { cwd: root, model: 'generator', signal: new AbortController().signal, maxTurns: 6,
      maxBudgetUsd: scenario === 'budget' ? 1 : null, prompt: { system: '', user: '' } as ExecRequest['prompt'],
      allowedTools: ['Write'], readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null };
    if (scenario === 'v4') {
      req.maxTurns = 15;
      req.guidedEngineVersion = 4;
      req.progress = new GuidedProgress(paths);
      const deps = contractDependencies(readFileSync(paths.intent, 'utf8'), [requestText]);
      req.progress.accept(req.progress.begin('intent:contract-checked', 'intent', deps), { checked: true }, deps, true);
    }
    const result = await new PlanSelectionExecutor({ paths, slug: 'test', candidates: 3,
      generator: { provider: generator, params: null, contextWindow: 32768 },
      judge: { provider: judge, model: 'judge', params: null, contextWindow: scenario === 'context' ? 50 : 32768 },
    }).run(req, hooks);
    const expected = scenario === 'select' || scenario === 'duplicate' || scenario === 'other_path' || scenario === 'v4';
    assert.equal(result.ok, expected, result.note);
    assert.equal(existsSync(paths.plan), expected);
    assert.equal(writes, expected || scenario === 'denied' ? 1 : 0);
    assert.equal(result.modelRequests, generated + judged);
    assert.equal(charged, generated + judged);
    assert.ok(generated + judged <= req.maxTurns);
    if (scenario === 'select') assert.match(readFileSync(paths.plan, 'utf8'), /variant 2/);
    const audit = JSON.parse(readFileSync(join(paths.runnerDir, 'plan-selection', readdirSync(join(paths.runnerDir, 'plan-selection'))[0]!), 'utf8'));
    assert.equal(audit.modelRequests, generated + judged);
    assert.equal(audit.status, expected ? 'complete' : scenario === 'denied' ? 'write_failed' : 'failed');
  });
}
