import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';
import type { StageId } from '@sdlc-runner/shared';
import { loadConfig } from '../server/src/config/load.ts';
import { resolveProfile } from '../server/src/config/profiles.ts';
import type { ProjectConfig } from '../server/src/config/schema.ts';
import { createProvider } from '../server/src/provider/registry.ts';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { GuidedExecutor } from '../server/src/exec/GuidedExecutor.ts';
import { findSymbols } from '../server/src/exec/symbolOps.ts';
import { initGuided } from '../server/src/run/guidedState.ts';
import { GuidedProgress } from '../server/src/run/guidedProgress.ts';
import type { ExecRequest, ExecHooks } from '../server/src/exec/StageExecutor.ts';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]!; };
const generatorId = option('--generator', 'ollama:ministral3-14b-instruct-ctx32k-compactfill');
const judgeId = option('--judge', 'ollama:qwen3.8-27b-iq4-gpumax');
const minutes = Number(option('--minutes', '3'));
const repeats = Number(option('--repeats', '1'));
const root = resolve('.');
type Case = { id: string; request: string; files: Record<string, string>; acceptance: { id: string; behavior: string; procedure: string; expected: string }[];
  checks: { symbol: string; args: unknown[]; expected: unknown }[] };
const cases: Case[] = JSON.parse(readFileSync(join(root, 'bench/experiments/plan-selection-cases.json'), 'utf8'));
if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(repeats) || repeats < 1 || cases.some(c => !c.checks?.length)) throw new Error('Invalid pilot limits/checks');
const modes = ['single', 'self', 'separate', 'stronger'];
if (!args.includes('--run')) {
  console.log(JSON.stringify({ generatorId, judgeId, cases: cases.map(c => c.id), modes, minutes, repeats,
    scope: 'Chunk component with actual behavior checks; not a full SDLC run' }, null, 2)); process.exit(0);
}
const id = `chunk-selection-${new Date().toISOString().replace(/\D/gu, '')}`;
const directory = join(root, 'bench/results', id); mkdirSync(directory, { recursive: true });
const config = loadConfig(join(root, 'config'));
const stages = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'] as StageId[];
const routeFor = (model: string) => {
  const project: ProjectConfig = { name: 'chunk-pilot', projectRoot: root, activeProfile: 'local', maxBudgetUsd: 1,
    profiles: { local: { label: 'chunk-pilot', stages: Object.fromEntries(stages.map(stage => [stage, model])) as Record<StageId, string> } } };
  const route = resolveProfile(project, config.models, 'local').routes.chunk;
  if (route.flow !== 'loop' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.providerDef.baseUrl ?? 'http://invalid').hostname)) throw new Error('Local routes required');
  return { provider: createProvider(route.provider, route.providerDef, 120000), model: route.model,
    params: route.params, contextWindow: route.contextWindow ?? 16384 };
};
const generator = routeFor(generatorId); const judge = routeFor(judgeId);
const fingerprint = () => {
  const hash = createHash('sha256');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path); else hash.update(path).update(readFileSync(join(root, path)));
    }
  };
  for (const directory of ['server/src', 'shared/src', 'config', 'bench/experiments']) visit(directory);
  hash.update(readFileSync(join(root, 'tools/chunk-selection-pilot.ts')));
  return hash.digest('hex');
};
const manifest: { id: string; status: string; codeHash: string; limits: unknown; generator: string; judge: string; runs: Record<string, unknown>[]; limitation: string } = {
  codeHash: fingerprint(),
  id, status: 'running', limits: { minutes, maxTurns: 24, candidateSeconds: 60, repeats }, generator: generatorId, judge: judgeId, runs: [],
  limitation: 'Fixed-input component experiment; one repeat is not statistically reliable, full-cycle acceptance is not measured.',
};
const save = () => writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2)); save();
for (const entry of cases) for (let repeat = 1; repeat <= repeats; repeat++) for (const mode of [...modes.slice((repeat - 1) % modes.length), ...modes.slice(0, (repeat - 1) % modes.length)]) {
  if (fingerprint() !== manifest.codeHash) { manifest.status = 'source-changed'; save(); throw new Error('Pilot sources changed; refusing to mix implementations'); }
  const workspace = join(root, '.tmp', id, `${entry.id}-${mode}-${repeat}`); mkdirSync(workspace, { recursive: true });
  for (const [path, content] of Object.entries(entry.files)) { mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), content); }
  const paths = new WitokPaths(workspace, 'case'); initGuided(paths, 'local:pilot', 4);
  const files = Object.keys(entry.files);
  const claims = entry.acceptance.map(claim => claim.id);
  const fileTasks = files.map(file => ({ file, title: entry.request, action: `Modify internal implementation: ${entry.request}`,
    claims, check: 'behavior checks', expect: 'all explicit examples pass', contractChange: 'public API unchanged',
    symbol: findSymbols(entry.files[file]!).find(s => s.kind === 'function')?.qualified ?? findSymbols(entry.files[file]!)[0]?.qualified ?? null }));
  let usage = emptyUsage(); const exchanges: unknown[] = [];
  const runName = `${entry.id}-${mode}-${repeat}`;
  const hooks: ExecHooks = { onText: text => console.log(text.trim()), onThinking() {}, onWarn: text => console.log(text), onFriction() {}, onToolResult() {},
    onAskHuman: async () => ({}), onRecord: () => '', onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' }),
    onUsage: value => { usage = addUsage(usage, value); }, onExchange: value => {
      exchanges.push(value); writeFileSync(join(directory, `${runName}-exchanges.json`), JSON.stringify(exchanges, null, 2));
    } };
  const evaluateContent = (contents: Record<string, string>) => {
    const source = files.map(file => stripTypeScriptTypes(contents[file]!)).join('\n');
    const results = entry.checks.map(check => {
      if (!/^[A-Za-z_$][\w$]*$/u.test(check.symbol)) throw new Error('Unsupported check symbol');
      try {
        const actual: unknown = runInNewContext(`${source}\n${check.symbol}(${check.args.map(arg => JSON.stringify(arg)).join(',')})`, {}, { timeout: 1000 });
        return { passed: isDeepStrictEqual(actual, check.expected), symbol: check.symbol, args: check.args, actual, expected: check.expected };
      } catch (error) { return { passed: false, error: String(error) }; }
    });
    return { passed: results.every(r => r.passed), result: JSON.stringify(results) };
  };
  const checkBehavior = () => evaluateContent(Object.fromEntries(files.map(file => [file, readFileSync(join(workspace, file), 'utf8')])));
  const evaluateCandidates = () => {
    const auditDirectory = join(paths.runnerDir, 'chunk-selection');
    let names: string[];
    try { names = readdirSync(auditDirectory); } catch { return []; }
    return names.flatMap(name => {
      const audit = JSON.parse(readFileSync(join(auditDirectory, name), 'utf8')) as {
        records: { kind: string; sample?: number; duplicateOf?: string | null; changes?: { path: string; after: string }[] }[] };
      return audit.records.filter(record => record.kind === 'candidate' && !record.duplicateOf).map(record => {
        const contents = { ...entry.files };
        for (const change of record.changes ?? []) {
          const file = relative(workspace, change.path).replace(/\\/gu, '/');
          if (!Object.hasOwn(contents, file)) throw new Error('Candidate outside benchmark fixture scope');
          contents[file] = change.after;
        }
        return { audit: name, candidate: `candidate-${record.sample}`, behaviorPassed: evaluateContent(contents).passed };
      });
    });
  };
  const model = mode === 'stronger' ? judge : generator;
  const req: ExecRequest = { cwd: workspace, model: model.model, signal: AbortSignal.timeout(minutes * 60000), maxTurns: 24,
    maxBudgetUsd: 1, allowedTools: ['Read', 'Grep', 'Write', 'Edit'], readOnlyDirs: [], subagents: [], mcp: null,
    prompt: { system: '', user: '', guidedProtocol: true } as ExecRequest['prompt'], guidedEngineVersion: 4,
    progress: new GuidedProgress(paths), finishGuard: null, salvageFromText: null };
  console.log(`START ${runName}`); const started = Date.now();
  try {
    const result = await new GuidedExecutor({ ...model, paths, writableFiles: files, draftPerFile: true,
      items: [{ id: 'group-1', files, claims, title: entry.request, prediction: 'required behavior holds', checks: ['behavior'],
        status: 'pending', attempts: 0, dependsOn: [], repartitioned: false }], inputRevision: () => 'fixed-input',
      requirements: JSON.stringify({ acceptance: entry.acceptance }), originalRequests: [entry.request],
      sources: JSON.stringify({ request: entry.request, files: entry.files }), fileTasks,
      ...(mode === 'self' || mode === 'separate' ? { chunkSelection: { candidates: 2 as const, judge: mode === 'self' ? generator : judge } } : {}),
      check: async () => checkBehavior(),
    }).run(req, hooks);
    const behavior = checkBehavior();
    const candidateBehavior = evaluateCandidates();
    manifest.runs.push({ case: entry.id, mode, repeat, workspace, ok: result.ok, behaviorPassed: behavior.passed,
      falseSuccess: result.ok && !behavior.passed, note: result.note, failure: result.failure, usage: result.usage,
      requests: result.modelRequests, seconds: (Date.now() - started) / 1000, behavior });
    Object.assign(manifest.runs.at(-1)!, { candidateBehavior,
      checkedCandidateAvailable: candidateBehavior.length ? candidateBehavior.some(candidate => candidate.behaviorPassed) : null });
    console.log(`DONE ${runName}: ok=${result.ok}, behavior=${behavior.passed}`);
  } catch (error) {
    manifest.runs.push({ case: entry.id, mode, repeat, workspace, ok: false, error: String(error), usage, seconds: (Date.now() - started) / 1000 });
    console.log(`FAILED ${runName}: ${String(error)}`);
  }
  save();
}
manifest.status = 'complete'; save(); console.log(directory);
