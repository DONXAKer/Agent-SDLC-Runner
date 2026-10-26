import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyUsage } from '@sdlc-runner/shared';
import { AXES } from '../src/artifacts/planAxes.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initializePreparation, preparation, recordPreparationRead, savePreparation } from '../src/artifacts/preparation.ts';
import { GuidedPlanExecutor } from '../src/exec/GuidedPlanExecutor.ts';
import { contractDependencies } from '../src/exec/guidedContract.ts';
import { GuidedProgress } from '../src/run/guidedProgress.ts';
import { initGuided } from '../src/run/guidedState.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

const turn = (value: unknown) => ({ text: JSON.stringify(value), toolCalls: [], finishReason: 'end_turn' as const, usage: emptyUsage() });

test('guided v5 executor consumes narrow operations and records the typed PlanIr', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plan-operations-executor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src/feature.ts'), 'export function existing() { return 1; }\n');
  writeFileSync(join(root, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(root, 'test/existing.test.ts'), '');
  const paths = new WitokPaths(root, 'typed-plan');
  initGuided(paths, 'local:test');
  const requestText = 'Реализация функции existing в src/feature.ts и её экспорт из src/index.ts. Добавить тесты в новом файле в test/.';
  initializePreparation(paths, requestText, 3);
  recordPreparationRead(paths, 'explore', 'src/feature.ts', readFileSync(join(root, 'src/feature.ts'), 'utf8'));
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, canonical: { requirements: {
    documentHash: 'test', acceptance: [{ id: 'claim-1', behavior: 'existing доступна из src/index.ts', procedure: 'Импортировать existing из src/index.ts', expected: 'Экспорт доступен' }],
    basis: [], constraints: { inScope: [], outOfScope: [], invariants: [], assumptions: [], questions: [] },
  } } });
  writeFileSync(paths.intent, '# Task\n## Что делаем\nРеализация функции existing в src/feature.ts и её экспорт из src/index.ts; добавить тесты в новом файле в test/.\n## Приёмочный лист\n| ID | Пункт | Процедура | Ожидаемый результат |\n|---|---|---|---|\n| claim-1 | existing доступна из src/index.ts | Импортировать existing из src/index.ts | Экспорт доступен |\n');
  const progress = new GuidedProgress(paths);
  const contract = contractDependencies(readFileSync(paths.intent, 'utf8'), [requestText]);
  progress.accept(progress.begin('intent:contract-checked', 'intent', contract), { checked: true }, contract, true);
  let calls = 0;
  const repairContexts: { focus: unknown; targets: unknown; feedback: unknown }[] = [];
  const provider = { name: 'operations-spy', async chat(req: any) {
    calls++;
    const schemaName = req.params.response_format.json_schema.name;
    if (schemaName === 'guided_plan_outline') return turn({
      approach: 'Use the inspected existing function in src/feature.ts', excluded: [], changes: 'No requirement changes', callers: [],
      axes: AXES.map(name => ({ affected: name === 'Совместимость и данные',
        reason: name === 'Совместимость и данные' ? 'The required public export changes the API' : 'No related impact',
        outcome: name === 'Совместимость и данные' ? 'claim-1' : 'н/п — no related impact' })),
      steps: [{ file: 'src/feature.ts', claims: ['claim-1'], dependsOn: [] }],
    });
    if (schemaName === 'guided_plan_card') return turn({
      symbol: 'missing', action: 'Adjust the requested behavior', check: 'Call existing', expected: 'The requested result', contract: 'Preserve the existing signature',
    });
    assert.equal(schemaName, 'guided_plan_repair_operations');
    const data = JSON.parse(req.messages[1].content);
    repairContexts.push({ focus: data.repairFocus, targets: data.repairTargets, feedback: data.feedback });
    assert.equal(req.params.response_format.json_schema.schema.properties.steps, undefined);
    return turn({ version: 1, operations: [{ op: 'setTarget', stepId: 1, file: 'src/feature.ts', symbol: 'existing' }] });
  } } as ChatProvider;
  const hooks: ExecHooks = {
    onText() {}, onThinking() {}, onUsage() {}, onWarn() {}, onFriction() {},
    onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }), onToolResult() {},
    onAskHuman: async () => ({}), onRecord: () => '',
  };
  const request: ExecRequest = {
    cwd: root, model: 'test', allowedTools: ['Read', 'Write', 'Edit'], signal: new AbortController().signal,
    maxTurns: 3, maxBudgetUsd: null, prompt: { system: '', user: '' } as ExecRequest['prompt'],
    readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null,
    guidedEngineVersion: 5, progress,
  };
  let rendered = '';
  const result = await new GuidedPlanExecutor({ provider, paths, contextWindow: 16000, slug: 'typed-plan', params: null,
    proposalOnly: true, onProposal: (_candidate, text) => { rendered = text; } }).run(request, hooks);
  assert.equal(result.ok, true, `${result.note}\n${JSON.stringify(repairContexts)}`);
  assert.equal(calls, 3);
  const saved = preparation(paths);
  assert.equal(saved?.ir?.plan?.version, 1);
  assert.equal(saved?.ir?.plan?.plan.steps[0]?.symbol, 'existing');
  assert.equal(saved?.ir?.plan?.plan.steps[0]?.file, 'src/feature.ts');
  assert.deepEqual(saved?.ir?.plan?.plan.steps.map(step => step.file), ['src/feature.ts', 'src/index.ts', 'test/existing.1.test.ts']);
  assert.equal(saved?.ir?.plan?.plan.steps[1]?.dependsOn[0], 1);
  assert.match(rendered, /### Шаг 1/);
  assert.match(rendered, /### Шаг 3/);
});
