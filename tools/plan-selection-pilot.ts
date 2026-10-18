import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';
import { loadConfig } from '../server/src/config/load.ts';
import { resolveProfile } from '../server/src/config/profiles.ts';
import { createProvider } from '../server/src/provider/registry.ts';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { initializePreparation, preparation, savePreparation, sourceHash, syncCanonicalPreparation } from '../server/src/artifacts/preparation.ts';
import { writeArtifact } from '../server/src/artifacts/artifact.ts';
import { GuidedPlanExecutor } from '../server/src/exec/GuidedPlanExecutor.ts';
import { PlanSelectionExecutor } from '../server/src/exec/PlanSelectionExecutor.ts';
import type { ExecRequest, ExecHooks } from '../server/src/exec/StageExecutor.ts';
import type { StageId } from '@sdlc-runner/shared';
import type { ProjectConfig } from '../server/src/config/schema.ts';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]!; };
const generatorId = option('--generator', 'ollama:gpt-oss-20b-compactfill');
const judgeId = option('--judge', 'ollama:qwen3.8-27b-iq4-gpumax');
const minutes = Number(option('--minutes', '5'));
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Invalid timeout');
const root = resolve('.');
const cases: { id: string; request: string; files: Record<string, string>; acceptance: { id: string; behavior: string; procedure: string; expected: string }[] }[] =
  JSON.parse(readFileSync(join(root, 'bench/experiments/plan-selection-cases.json'), 'utf8'));
if (!args.includes('--run')) {
  console.log(JSON.stringify({ generator: generatorId, judge: judgeId, minutes, cases: cases.map(c => c.id),
    modes: ['single', 'self', 'separate', 'stronger'], scope: 'plan component only' }, null, 2));
  process.exit(0);
}
const id = `plan-component-${new Date().toISOString().replace(/\D/gu, '')}`;
const directory = join(root, 'bench/results', id);
mkdirSync(directory, { recursive: true });
const config = loadConfig(join(root, 'config'));
const stages = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'] as StageId[];
const routeFor = (model: string) => {
  const project: ProjectConfig = { name: 'plan-pilot', projectRoot: root, activeProfile: 'local', maxBudgetUsd: 1,
    profiles: { local: { label: 'plan-pilot', stages: Object.fromEntries(stages.map(stage => [stage, model])) as Record<StageId, string> } } };
  const route = resolveProfile(project, config.models, 'local').routes.plan;
  if (route.flow !== 'loop' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.providerDef.baseUrl ?? 'http://invalid').hostname))
    throw new Error('Pilot requires local models');
  return { provider: createProvider(route.provider, route.providerDef, Math.min(minutes * 60000, 120000)),
    model: route.model, params: route.params, contextWindow: route.contextWindow ?? 16384 };
};
const generator = routeFor(generatorId); const judge = routeFor(judgeId);
const manifest: { id: string; generator: string; judge: string; limitation: string; runs: Record<string, unknown>[]; status: string } = {
  id, generator: generatorId, judge: judgeId, status: 'running',
  limitation: 'Component pilot on fixed explicit inputs. Runtime-valid plans are not proof of semantic correctness or successful implementation.', runs: [],
};
const save = () => writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2));
save();
for (const entry of cases) for (const mode of ['single', 'self', 'separate', 'stronger']) {
  const workspace = join(root, '.tmp', id, `${entry.id}-${mode}`);
  mkdirSync(workspace, { recursive: true });
  for (const [path, content] of Object.entries(entry.files)) {
    const target = join(workspace, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, content);
  }
  const paths = new WitokPaths(workspace, 'case');
  initializePreparation(paths, entry.request, 3);
  writeArtifact(paths.intent, `# Task\n## Что делаем\n${entry.request}\n## Чего не делаем\nNo public API changes.\n` +
    '\n## Приёмочный лист\n| ID | Пункт | Как проверить (процедура + критерий) |\n|---|---|---|\n' +
    entry.acceptance.map(c => `| ${c.id} | ${c.behavior} | Процедура: ${c.procedure}. Ожидаемо: ${c.expected} |`).join('\n') +
    '\n\n## Основания и сценарии\n| ID | Основание | Сценарий | Контрпример |\n|---|---|---|---|\n' +
    entry.acceptance.map(c => `| ${c.id} | ${entry.request} | ${c.procedure} | Original function returns the input unchanged |`).join('\n') + '\n');
  writeArtifact(paths.explorationReport, Object.entries(entry.files).map(([path, content]) => `${path}:\n${content}`).join('\n'));
  const state = preparation(paths)!;
  savePreparation(paths, { ...state, readEvidence: Object.entries(entry.files).map(([path, content]) => ({
    path, sourceHash: sourceHash(content), excerptHash: sourceHash(content), stage: 'explore' as const,
  })), canonical: { requirements: { documentHash: sourceHash(entry.request), acceptance: entry.acceptance, basis: [],
    constraints: { inScope: [entry.request], outOfScope: ['Public API changes'], invariants: [], assumptions: [], questions: [] } } } });
  syncCanonicalPreparation(paths);
  const exchanges: unknown[] = []; let usage = emptyUsage();
  const hooks: ExecHooks = { onText: text => console.log(text.trim()), onThinking() {}, onWarn: text => console.log(text),
    onFriction() {}, onRecord: () => '', onToolResult() {}, onAskHuman: async () => ({}),
    onExchange: value => { exchanges.push(value); writeFileSync(join(directory, `${entry.id}-${mode}-exchanges.json`), JSON.stringify(exchanges, null, 2)); },
    onUsage: value => { usage = addUsage(usage, value); },
    onToolRequest: async () => ({ allowed: true, by: 'policy', updatedInput: null }),
  };
  const req: ExecRequest = { cwd: workspace, model: mode === 'stronger' ? judge.model : generator.model,
    prompt: { system: '', user: '' } as ExecRequest['prompt'], maxTurns: 30, maxBudgetUsd: 1,
    signal: AbortSignal.timeout(minutes * 60000), allowedTools: ['Write'], readOnlyDirs: [], subagents: [], mcp: null,
    finishGuard: null, salvageFromText: null };
  console.log(`START ${entry.id} ${mode}`);
  const started = Date.now();
  try {
    const model = mode === 'stronger' ? judge : generator;
    const executor = mode === 'self' || mode === 'separate'
      ? new PlanSelectionExecutor({ paths, slug: 'case', generator, judge: mode === 'self' ? generator : judge, candidates: 3 })
      : new GuidedPlanExecutor({ ...model, paths, slug: 'case' });
    const result = await executor.run(req, hooks);
    manifest.runs.push({ case: entry.id, mode, workspace, ok: result.ok, note: result.note, usage: result.usage,
      requests: result.modelRequests, seconds: (Date.now() - started) / 1000, plan: result.finalText });
    console.log(`DONE ${entry.id} ${mode}: ${result.ok} ${result.note}`);
  } catch (error) {
    manifest.runs.push({ case: entry.id, mode, workspace, ok: false, error: String(error), usage,
      seconds: (Date.now() - started) / 1000 }); console.log(`FAILED ${entry.id} ${mode}: ${String(error)}`);
  }
  save();
}
manifest.status = 'complete'; save(); console.log(directory);
