import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessGuidedValidation } from '../bench/src/guidedValidation.ts';
import { seriesCases, selectV4HoldoutModels } from './guided-series.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const phase = option('--phase', 'comparison');
if (!['baseline', 'progress', 'comparison', 'holdout', 'smoke'].includes(phase)) throw new Error('Unknown phase');
let models = [
  'ollama:gpt-oss-20b-compactfill',
  'ollama:ministral3-14b-instruct-ctx32k-compactfill',
  'ollama:qwen3.8-27b-iq4-gpumax',
  'ollama:mellum2-12b-instruct-q6-compactfill',
];
const tasks = phase === 'holdout' ? ['rename-field', 'idempotent-retry'] : ['add-validator', 'config-default'];
const repeats = ['baseline', 'progress', 'smoke'].includes(phase) ? 1 : 3;
const versions = option('--versions', phase === 'smoke' ? '4' : phase === 'baseline' ? '1' : phase === 'progress' ? '2' : '1,3').split(',').map(Number);
if (!versions.length || versions.some(v => ![1, 2, 3, 4].includes(v)) || new Set(versions).size !== versions.length) throw new Error('Invalid --versions');
if (phase === 'smoke' && String(versions) !== '4') throw new Error('Smoke requires version 4');
if (phase === 'holdout' && versions.includes(4)) {
  const priorPath = option('--comparison', null);
  if (!priorPath) throw new Error('V4 holdout requires --comparison <manifest>, including dry runs');
  const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  if (prior.phase !== 'comparison' || prior.status !== 'complete' || String([...new Set(prior.cases.map(c => c.version))].sort()) !== '3,4') throw new Error('Complete v3/v4 comparison required');
  models = selectV4HoldoutModels(prior.runs);
  if (!models.length) throw new Error('No models qualify for holdout: v4 needs at least 2/3 successes on EACH task');
}
const hash = () => {
  const result = createHash('sha256');
  const visit = path => {
    if (!existsSync(join(root, path))) return;
    for (const item of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink() || ['node_modules', '.git', '.runner', 'dist'].includes(item.name)) continue;
      const file = `${path}/${item.name}`;
      if (item.isDirectory()) visit(file);
      else result.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
    }
  };
  for (const directory of ['server/src', 'shared/src', 'bench/src', 'config', 'bench/fixtures', 'bench/checks', 'bench/expected']) visit(directory);
  for (const path of ['package-lock.json', 'tools/compare-guided.mjs', 'tools/guided-suite-success.ts', 'tools/guided-series.ts']) result.update(path).update(readFileSync(join(root, path)));
  return result.digest('hex');
};
const cases = seriesCases(models, tasks, versions, repeats);
if (!args.includes('--run')) {
  console.log(JSON.stringify({ phase, cases, limits: { stageMinutes: 30, runMinutes: 60 }, holdout: ['rename-field', 'idempotent-retry'] }, null, 2));
  process.exit(0);
}
if (phase === 'holdout' && !versions.includes(4)) {
  const priorPath = option('--comparison', null);
  if (!priorPath) throw new Error('Holdout requires --comparison <manifest>');
  const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  const success = version => prior.runs.filter(r => r.version === version && r.success).length;
  if (prior.phase !== 'comparison' || prior.status !== 'complete' || prior.runs.some(r => !['success', 'failed'].includes(r.status)) || success(3) <= success(1) ||
      prior.runs.some(r => r.version === 3 && (r.falseSuccess || r.scopeFailure))) throw new Error('Comparison has not established improvement');
}
const resume = option('--resume', null);
const localEnvironment = async () => {
  const provider = JSON.parse(readFileSync(join(root, 'config/models.json'), 'utf8'));
  const registry = [];
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (models.includes(value.id)) registry.push(Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('//'))));
    Object.values(value).forEach(collect);
  };
  collect(provider);
  if (registry.length !== models.length) throw new Error('Cannot identify every registered local model');
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const get = async path => {
    const response = await fetch(`${base.replace(/\/v1\/?$/u, '').replace(/\/$/u, '')}${path}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Ollama preflight ${response.status}`);
    return response.json();
  };
  const [version, tags] = await Promise.all([get('/api/version'), get('/api/tags')]);
  const installed = registry.map(model => {
    const tag = tags.models?.find(tag => tag.name === model.model || tag.name === `${model.model}:latest`);
    if (!tag) throw new Error(`Local model not installed: ${model.model}`);
    return { registry: model, tag: tag.name, digest: tag.digest, size: tag.size };
  });
  return { ollamaVersion: version.version, baseUrl: base, models: installed };
};
const environment = await localEnvironment();
const id = `guided-${phase}-${new Date().toISOString().replace(/\D/g, '')}`;
const directory = resume ? resolve(resume) : join(root, 'bench/results', id);
mkdirSync(directory, { recursive: true });
const manifestFile = join(directory, 'suite.json');
const manifest = resume ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {
  id, phase, status: 'running', codeHash: hash(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  environment, cases, limits: { stageMinutes: 30, runMinutes: 60 }, holdout: ['rename-field', 'idempotent-retry'], runs: [],
};
if (manifest.phase !== phase || manifest.codeHash !== hash() || JSON.stringify(manifest.cases) !== JSON.stringify(cases)) throw new Error('Source/config/fixture fingerprint or cases changed; start a new series');
if (JSON.stringify(manifest.environment) !== JSON.stringify(environment)) throw new Error('Local backend/model fingerprint changed; start a new series');
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const save = () => {
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const rows = manifest.runs.map(r => `<tr><td>${escape(r.model)}</td><td>${escape(r.task)}</td><td>${r.version}</td><td>${r.repeat}</td><td>${escape(r.status)}</td><td>${escape(r.stopped)}</td><td>${escape(r.minutes)}</td><td>${escape(r.tokens)}</td><td><a href="../../traces/${escape(r.slug)}/flow.html">flow</a> <a href="../${escape(r.slug)}.json">result</a> <a href="${escape(r.slug)}.log">log</a></td></tr>`).join('');
  writeFileSync(join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Guided comparison</title><style>body{font:16px system-ui;margin:30px}td,th{padding:8px;border:1px solid #aaa}table{border-collapse:collapse}</style><h1>${escape(manifest.id)}</h1><p>${escape(manifest.status)} · ${escape(manifest.codeHash)}</p><p>Success requires handoff, verdict and all hidden tests. Missing results and interrupted runs are not model failures. Proposals are not verified facts.</p><table><tr><th>Model</th><th>Task</th><th>Engine</th><th>Repeat</th><th>Result</th><th>Stop</th><th>Minutes</th><th>Tokens</th><th>Evidence</th></tr>${rows}</table>`);
};
save(); console.log(`MANIFEST ${manifestFile}`);
for (const [index, entry] of manifest.cases.entries()) {
  if (hash() !== manifest.codeHash) throw new Error('Fingerprint changed during series');
  if (JSON.stringify(await localEnvironment()) !== JSON.stringify(manifest.environment)) throw new Error('Backend/model changed during series');
  if (manifest.runs.some(r => r.caseIndex === index && !['running', 'interrupted', 'no-result'].includes(r.status))) continue;
  // A killed process is preserved as interrupted, never silently counted or overwritten.
  for (const old of manifest.runs.filter(r => r.caseIndex === index && r.status === 'running')) old.status = 'interrupted';
  const slug = `${manifest.id}-${index + 1}-${manifest.runs.length + 1}`;
  const cli = ['bench/src/cli.ts', '--all', '--model', entry.model, '--task', entry.task, '--execution-mode', 'guided',
    '--guided-engine-version', String(entry.version), '--preparation-version', '3', '--strict-questions',
    '--stage-timeout', String(manifest.limits.stageMinutes), '--run-timeout', String(manifest.limits.runMinutes), '--attempts', '3', '--slug', slug];
  const run = { ...entry, caseIndex: index, slug, args: cli, status: 'running', startedAt: new Date().toISOString() };
  manifest.runs.push(run); save(); console.log(`START ${index + 1}/${manifest.cases.length} v${entry.version} ${entry.model} ${entry.task}`);
  const fd = openSync(join(directory, `${slug}.log`), 'w');
  try {
    run.exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, cli, { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true });
      child.once('error', reject); child.once('exit', done);
    });
  } catch (error) { run.error = String(error); }
  finally { closeSync(fd); }
  run.finishedAt = new Date().toISOString();
  run.minutes = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 60000;
  let result = null;
  try { result = JSON.parse(readFileSync(join(root, 'bench/results', `${slug}.json`), 'utf8')); } catch { /* report absence explicitly */ }
  const assessment = assessGuidedValidation(result, { slug, model: entry.model, task: entry.task,
    startedAt: run.startedAt, finishedAt: run.finishedAt, guidedEngineVersion: entry.version }, run.exitCode ?? null);
  const comparable = result?.run.executionMode === 'guided' && result?.run.preparationVersion === 3 &&
    result?.run.strictQuestions === true && result?.guided?.engineVersion === entry.version && hash() === manifest.codeHash;
  run.success = comparable && assessment.success;
  run.status = assessment.status === 'no-current-result' || !result ? 'no-result' : !comparable ? 'incomparable' : run.success ? 'success' : assessment.status === 'environment-failure' ? 'environment-failure' : 'failed';
  run.outcomeKind = assessment.outcomeKind;
  run.evidenceLevel = assessment.evidenceLevel;
  run.modelTaskEvaluated = assessment.modelTaskEvaluated;
  run.operationalSuccess = comparable && assessment.operationalSuccess;
  run.environmentFailure = assessment.environmentFailure;
  run.stopped = result?.driver?.stopped ?? null;
  run.falseSuccess = result?.finalVerdict?.passed === true && (result?.hidden?.fail > 0 || result?.honesty?.some(c => c.ok === false));
  run.scopeFailure = result?.honesty?.some(c => c.method === 'destructiveOrPolicyDenied' && c.ok === false) ?? false;
  run.progress = result?.guided?.progress ?? null;
  run.workload = result?.guided?.workload ?? null;
  run.failure = result?.driver?.stages?.findLast(stage => !stage.ok)?.failure ?? null;
  run.hidden = result?.hidden ?? null;
  run.routes = result?.run?.routes ?? null;
  run.tokens = result?.metrics?.stages?.reduce((total, stage) => total + (stage.usage?.inputTokens ?? 0) + (stage.usage?.outputTokens ?? 0), 0) ?? null;
  save(); console.log(`DONE ${index + 1}/${manifest.cases.length} ${run.status} ${run.stopped}`);
}
manifest.status = 'complete'; manifest.finishedAt = new Date().toISOString(); save();
