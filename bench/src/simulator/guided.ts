import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WitokPaths } from '../../../server/src/artifacts/paths.ts';
import { GuidedProgress } from '../../../server/src/run/guidedProgress.ts';
import { GuidedExploreExecutor } from '../../../server/src/exec/GuidedExploreExecutor.ts';
import type { ExploreExecutorOptions } from '../../../server/src/exec/ExploreExecutor.ts';
import type { ExecHooks, ExecRequest } from '../../../server/src/exec/StageExecutor.ts';
import { reviewByHunks } from '../../../server/src/run/reviewFill.ts';
import { intentClaimSetProblem, sourceScopeIssues } from '../../../server/src/exec/guidedContract.ts';
import { ScriptedProvider, textTurn } from './scriptedProvider.ts';
import type { SimulationCaseResult } from './taskLoop.ts';

type Observation = { actual: string; checks: string[]; trace: unknown[] };

/** Это компонентные прогоны guided, а не доказательство полного семиэтапного витка. */
export async function runGuidedScenarios(): Promise<SimulationCaseResult[]> {
  const results: SimulationCaseResult[] = [];
  async function scenario(id: string, expected: string, body: (observation: Observation) => Promise<void>) {
    const observation: Observation = { actual: 'не завершён', checks: [], trace: [] };
    const errors: string[] = [];
    try { await body(observation); } catch (error) { errors.push(String(error)); }
    results.push({ id, expected, ...observation, passed: errors.length === 0, errors });
  }

  for (const repair of [true, false]) {
    await scenario(repair ? 'guided-json-repair' : 'guided-json-rejected',
      repair ? 'Повреждённый JSON исправлен одним повтором; ревью завершено' : 'Два повреждённых ответа оставляют ревью незавершённым', async o => {
        const provider = new ScriptedProvider('guided-review-script', [textTurn('{broken'), textTurn(repair ? '{"findings":[]}' : '{}')]);
        const validations: unknown[] = [];
        try {
          const result = await reviewByHunks({ guided: true, provider, model: 'script', params: null,
            taskContext: 'Сохранить числовой экспорт', sourceHunks: [{ file: 'src/count.ts', text: 'export const count = 1;' }],
            diff: '', axes: [], hunkBudgetBytes: 8000, signal: new AbortController().signal,
            onValidation: value => validations.push(value) });
          o.actual = `${result.hunksAnswered}/${result.hunksAsked} фрагментов проверено`;
          assert.equal(result.hunksAsked, 1);
          assert.equal(result.hunksAnswered, repair ? 1 : 0);
          assert.equal(provider.requests.length, 2);
          assert.equal(provider.remaining, 0);
          assert.deepEqual(provider.errors, []);
          assert.ok(provider.requests.every(req => req.tools.length === 0));
          assert.deepEqual(validations.map(v => (v as { accepted: boolean }).accepted), [false, repair]);
          o.checks.push('Лимит повторов', 'Неполный ответ не считается чистым ревью', 'Нативный tool calling не требуется');
        } finally { o.trace.push(...provider.exchanges, ...validations.map(validation => ({ validation }))); }
      });
  }

  await scenario('guided-research-resume', 'После отмены переиспользуется первый файл; изменённый источник перечитывается', async o => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-sim-guided-'));
    const paths = new WitokPaths(root, 'research');
    const reply = textTurn(JSON.stringify({ fact: 'Экспортирована числовая константа', impact: 'Сохранить экспорт', change: null, reuse: null, risks: [], questions: [] }));
    const controller = new AbortController();
    const provider = new ScriptedProvider('guided-research-script', [reply,
      () => { controller.abort(new Error('SIMULATED_INTERRUPTION')); throw controller.signal.reason; }, reply, reply]);
    const events: unknown[] = [];
    try {
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.intent, 'Исследовать a.ts и b.ts, сохранить экспорты.');
      for (const file of ['a.ts', 'b.ts']) writeFileSync(join(root, file), 'export const value = 1;');
      const hooks: ExecHooks = { onText: text => events.push({ text }), onThinking() {}, onUsage() {},
        onWarn: warning => events.push({ warning }), onFriction() {},
        onToolRequest: async call => { events.push({ call }); return { allowed: true, updatedInput: null, by: 'policy' }; },
        onToolResult() {}, onAskHuman: async () => ({}), onRecord: () => '' };
      const options = (): ExploreExecutorOptions => ({ provider,
        built: { ranked: ['a.ts', 'b.ts'].map(path => ({ file: { path, text: readFileSync(join(root, path), 'utf8') } })) },
        intent: { path: paths.intent, title: 'Исследование', claims: [] }, reportPath: paths.explorationReport,
        maxResultBytes: 10000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 1000 } as unknown as ExploreExecutorOptions);
      const request = (signal: AbortSignal): ExecRequest => ({ cwd: root, model: 'script', allowedTools: ['Write', 'Read'], signal,
        maxTurns: 8, maxBudgetUsd: null,
        prompt: { system: '', user: '', tools: [], presetNote: null, editedByOperator: false },
        readOnlyDirs: [], subagents: [], mcp: null, finishGuard: null, salvageFromText: null,
        progress: new GuidedProgress(paths) });
      await assert.rejects(() => new GuidedExploreExecutor(options()).run(request(controller.signal), hooks), /SIMULATED_INTERRUPTION/);
      assert.equal(new GuidedProgress(paths).read().units['explore:a.ts']?.status, 'proposed');
      const resumed = await new GuidedExploreExecutor(options()).run(request(new AbortController().signal), hooks);
      assert.equal(resumed.ok, true, resumed.note);
      assert.equal(resumed.modelRequests, 1);
      writeFileSync(join(root, 'b.ts'), 'export const value = 2;');
      const updated = await new GuidedExploreExecutor(options()).run(request(new AbortController().signal), hooks);
      assert.equal(updated.ok, true, updated.note);
      assert.equal(updated.modelRequests, 1);
      const sourcePaths = provider.requests.map(req => (JSON.parse(req.messages[1]!.content) as { source: { path: string } }).source.path);
      assert.deepEqual(sourcePaths, ['a.ts', 'b.ts', 'b.ts', 'b.ts']);
      assert.ok(provider.requests.every(req => req.tools.length === 0));
      assert.deepEqual(provider.errors, []);
      assert.equal(provider.remaining, 0);
      o.actual = 'Разведка восстановлена; после изменения b.ts выполнен один новый запрос';
      o.checks.push('Состояние восстановлено новым GuidedProgress', 'Отсутствует повтор завершённой единицы', 'Изменение источника инвалидирует кеш', 'JSON без tool calling записан настоящим исполнителем');
      o.trace.push({ report: readFileSync(paths.explorationReport, 'utf8'), progress: new GuidedProgress(paths).read() });
    } finally {
      o.trace.push(...provider.exchanges, ...events);
      rmSync(root, { recursive: true, force: true });
    }
  });

  await scenario('guided-frozen-model-failures', 'Записанные ошибки моделей отклонены текущими проверками контракта', async o => {
    const directory = new URL('../../../server/test/fixtures/guided-v4/', import.meta.url);
    const source = readFileSync(new URL('original-request.md', directory), 'utf8');
    const exclusion = readFileSync(new URL('ministral-invented-exclusion.md', directory), 'utf8');
    const dropped = readFileSync(new URL('gptoss-dropped-claim.md', directory), 'utf8');
    const scope = sourceScopeIssues(exclusion, [source]);
    const claims = intentClaimSetProblem(dropped, [source]);
    o.trace.push({ source, exclusion, dropped, scope, claims });
    assert.ok(scope.some(issue => issue.problem.includes('src/index.ts')));
    assert.match(claims ?? '', /claim-5/);
    o.actual = 'Выдуманное исключение и потеря claim-5 обнаружены';
    o.checks.push('Повтор сохранённых артефактов, без нового вызова модели', 'Результат не считается прогнозом ответа после изменения промпта');
  });
  return results;
}
