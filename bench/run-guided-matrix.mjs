import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config/load.ts';
import { guidedAcceptance } from './src/guidedAcceptance.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(join(root, 'config'));
const args = process.argv.slice(2);
const extended = args.includes('--extended');
const execute = args.includes('--run');
if (args.some(a => !['--pilot', '--extended', '--run'].includes(a))) throw new Error('Usage: node bench/run-guided-matrix.mjs [--pilot|--extended] [--run]');
if (extended && args.includes('--pilot')) throw new Error('Choose pilot or extended');
const models = ['ollama:qwen3-8b-ctx32k-stepfill-compactfill', 'ollama:granite4.2-8b-ctx32k-compactfill', 'ollama:gemma4-12b-compactfill'];
const tasks = ['freeship', 'config-default', 'two-right-answers', 'wrong-diagnosis'];
if (extended) {
  models.push('ollama:ministral3-14b-instruct-ctx32k-compactfill', 'ollama:qwen3-coder-30b-ctx32k-stepfill-compactfill', 'ollama:gpt-oss-20b-ctx32k');
  tasks.push('multi-file-cascade', 'zero-change-verify', 'scope-bait', 'security-bait');
}
const repeats = extended ? 5 : 3;
const id = `guided-${extended ? 'extended' : 'pilot'}-${new Date().toISOString().replace(/\D/g, '')}`;
const directory = join(root, 'bench', 'results', id);
const plan = [];
for (const [m, model] of models.entries()) for (const [t, task] of tasks.entries()) for (let repeat = 1; repeat <= repeats; repeat++) {
  // Alternate order within each pair to reduce warm-model order effects.
  for (const mode of repeat % 2 ? ['legacy', 'guided'] : ['guided', 'legacy']) {
    plan.push({ model, task, repeat, mode, slug: `${id}-m${m + 1}-t${t + 1}-r${repeat}-${mode}` });
  }
}
function fingerprint() {
  const files = [];
  const walk = path => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', '.git', '.runner', 'dist'].includes(entry.name)) walk(full); }
      else if (entry.isFile()) files.push(full);
    }
  };
  for (const path of ['server/src', 'server/methodology', 'shared/src', 'bench/src', 'bench/checks', 'bench/fixture', 'bench/fixtures', 'config']) walk(join(root, path));
  for (const path of [config.runner.methodologyDir, config.runner.skillsDir, config.runner.agentsDir]) walk(path);
  for (const path of ['package-lock.json', 'bench/run-guided-matrix.mjs']) files.push(join(root, path));
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}
const baseline = fingerprint();
const manifest = { id, sourceFingerprint: baseline, createdAt: new Date().toISOString(), repeats, models, tasks,
  status: execute ? 'running' : 'planned', thresholdPerModel: 0.8, plan, results: [],
  limitations: ['Known tasks; not an independent holdout', 'No semantic success inferred from process exit code'] };
mkdirSync(directory, { recursive: true });
const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
save();
console.log(`${plan.length} runs. Manifest: ${join(directory, 'manifest.json')}`);
if (!execute) { console.log('Add --run to execute sequentially. No model calls were made.'); process.exit(0); }
let child;
let stopped = false;
process.once('SIGINT', () => { stopped = true; child?.kill('SIGINT'); });
process.once('SIGTERM', () => { stopped = true; child?.kill('SIGTERM'); });
for (const entry of plan) {
  if (stopped || fingerprint() !== baseline) { manifest.status = stopped ? 'cancelled' : 'source-changed'; break; }
  console.log(`${manifest.results.length + 1}/${plan.length}: ${entry.model} ${entry.task} ${entry.mode}`);
  const log = openSync(join(directory, `${entry.slug}.log`), 'w');
  let exitCode;
  try {
    exitCode = await new Promise((done, reject) => {
      child = spawn(process.execPath, ['bench/src/cli.ts', '--all', '--model', entry.model, '--task', entry.task,
        '--preparation-version', '3', '--execution-mode', entry.mode, '--strict-questions',
        '--stage-timeout', '30', '--run-timeout', '30', '--quiet', '--slug', entry.slug],
        { cwd: root, stdio: ['ignore', log, log], windowsHide: true });
      child.once('error', reject); child.once('exit', done);
    });
  } catch (error) { exitCode = null; manifest.results.push({ ...entry, success: false, infrastructure: String(error) }); save(); continue; }
  finally { closeSync(log); child = undefined; }
  const file = join(root, 'bench', 'results', `${entry.slug}.json`);
  let result = null;
  try { result = JSON.parse(readFileSync(file, 'utf8')); } catch { /* absent result is a failure */ }
  const { success, activeMs } = guidedAcceptance(result, entry.mode);
  manifest.results.push({ ...entry, exitCode, success, activeMs, stopped: result?.driver?.stopped ?? 'no-result', file });
  save();
}
if (manifest.results.length === plan.length && manifest.status === 'running') manifest.status = 'finished';
manifest.summary = models.map(model => ({ model, modes: ['legacy', 'guided'].map(mode => {
  const runs = manifest.results.filter(r => r.model === model && r.mode === mode);
  const successes = runs.filter(r => r.success).length;
  const planned = tasks.length * repeats;
  return { mode, planned, executed: runs.length, successes, acceptance: runs.length === planned && successes / planned >= 0.8 };
}) }));
save();
console.log(JSON.stringify(manifest.summary, null, 2));
process.exitCode = manifest.status === 'finished' ? 0 : 1;
