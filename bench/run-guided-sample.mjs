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
const selectedModels = []; const selectedTasks = [];
let planSmoke = false; let quick = false; let repeats = 1;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--plan-smoke') { planSmoke = true; quick = true; }
  else if (arg === '--quick') quick = true;
  else if (arg === '--repeats') {
    const value = args[++i];
    if (!value || !/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 10) throw new Error('--repeats requires an integer from 1 to 10');
    repeats = Number(value);
  }
  else if (arg === '--model' || arg === '--task') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    (arg === '--model' ? selectedModels : selectedTasks).push(value);
  } else throw new Error(`Unknown option: ${arg}`);
}
const models = selectedModels.length ? [...new Set(selectedModels)] : quick ? ['ollama:granite4.2-8b-ctx32k-compactfill'] : [
  'ollama:qwen3-8b-ctx32k-stepfill-compactfill',
  'ollama:granite4.2-8b-ctx32k-compactfill',
  'ollama:gemma4-12b-compactfill',
  'ollama:ministral3-14b-instruct-ctx32k-compactfill',
  'ollama:gpt-oss-20b-ctx32k',
];
const tasks = selectedTasks.length ? [...new Set(selectedTasks)] : planSmoke ? ['add-validator'] : quick ? ['add-validator', 'zero-change-verify'] : ['already-done', 'zero-change-verify'];
const id = `guided-sample-${new Date().toISOString().replace(/\D/g, '')}`;
const directory = join(root, 'bench', 'results', id);
const plan = Array.from({ length: repeats }, (_, ri) => models.flatMap((model, mi) => tasks.map((task, ti) => ({
  model, task, repeat: ri + 1, slug: `${id}-m${mi + 1}-t${ti + 1}${repeats > 1 ? `-r${ri + 1}` : ''}`,
})))).flat();

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
  for (const path of ['package-lock.json', 'bench/run-guided-sample.mjs']) files.push(join(root, path));
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

const baseline = fingerprint();
const stageTimeout = planSmoke ? 5 : 12;
const runTimeout = planSmoke ? 8 : 30;
const manifest = { id, sourceFingerprint: baseline, createdAt: new Date().toISOString(), models, tasks, repeats,
  stageTimeoutMinutes: stageTimeout, runTimeoutMinutes: runTimeout, stopAfterStage: planSmoke ? 'plan' : null, status: 'running', plan, results: [],
  limitations: [repeats === 1 ? 'One guided run per model/task: screening only, no success-rate estimate' : `Cell success = pass in >=${Math.max(2, Math.ceil(repeats * 2 / 3))} of ${repeats} repeats by guidedAcceptance`,
    tasks.every(t => t.startsWith('holdout-')) ? 'Holdout tasks; not used during guided-flow debugging' : 'Known tasks; not an independent holdout'] };
mkdirSync(directory, { recursive: true });
const save = () => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
save();
console.log(`${plan.length} guided runs. Manifest: ${join(directory, 'manifest.json')}`);

let child;
let stopped = false;
process.once('SIGINT', () => { stopped = true; child?.kill('SIGINT'); });
process.once('SIGTERM', () => { stopped = true; child?.kill('SIGTERM'); });
for (const [index, entry] of plan.entries()) {
  if (stopped || fingerprint() !== baseline) { manifest.status = stopped ? 'cancelled' : 'source-changed'; break; }
  console.log(`${index + 1}/${plan.length}: ${entry.model} ${entry.task} repeat ${entry.repeat}`);
  const log = openSync(join(directory, `${entry.slug}.log`), 'w');
  let exitCode;
  try {
    exitCode = await new Promise((done, reject) => {
      child = spawn(process.execPath, ['bench/src/cli.ts', '--all', '--model', entry.model, '--task', entry.task,
        '--preparation-version', '3', '--execution-mode', 'guided', '--strict-questions',
        '--stage-timeout', String(stageTimeout), '--run-timeout', String(runTimeout),
        '--keep-workspace',
        ...(planSmoke ? ['--stop-after-stage', 'plan'] : []), '--quiet', '--slug', entry.slug],
        { cwd: root, stdio: ['ignore', log, log], windowsHide: true });
      child.once('error', reject); child.once('exit', done);
    });
  } catch (error) { exitCode = null; manifest.results.push({ ...entry, success: false, infrastructure: String(error) }); save(); continue; }
  finally { closeSync(log); child = undefined; }
  const file = join(root, 'bench', 'results', `${entry.slug}.json`);
  let result = null;
  try { result = JSON.parse(readFileSync(file, 'utf8')); } catch { /* absent result is recorded as failure */ }
  const { success, activeMs } = guidedAcceptance(result, 'guided');
  const target = result?.driver?.stages?.filter(stage => stage.stage === 'plan').at(-1);
  const targetPassed = planSmoke && target?.ok === true && target.skipped !== true && target.timedOut !== true;
  const run = { ...entry, exitCode, success, ...(planSmoke ? { targetPassed } : {}), activeMs, stopped: result?.driver?.stopped ?? 'no-result', file };
  manifest.results.push(run);
  save();
  console.log(`  ${success ? 'PASS' : targetPassed ? 'PLAN PASSED (not full success)' : 'STOP'} at ${run.stopped}; ${Math.round((activeMs ?? 0) / 60000)} active minutes`);
}
if (manifest.results.length === plan.length && manifest.status === 'running') manifest.status = 'finished';
manifest.summary = models.map(model => ({ model, runs: manifest.results.filter(r => r.model === model).map(r => ({ task: r.task, repeat: r.repeat, success: r.success, stopped: r.stopped })) }));
// Воспроизводимость ячейки model×task: одиночный pass не считается успехом — нужно ≥2/3
// повторов (минимум два) по тому же guidedAcceptance. Порог выводится из repeats серии,
// а не зашит: --repeats 3 даёт ровно «2 из 3», --repeats 1 остаётся скринингом.
const cellThreshold = repeats >= 2 ? Math.max(2, Math.ceil(repeats * 2 / 3)) : 1;
manifest.cells = models.flatMap(model => tasks.map(task => {
  const runs = manifest.results.filter(r => r.model === model && r.task === task);
  const passes = runs.filter(r => r.success).length;
  return { model, task, repeats: runs.length, passes, threshold: cellThreshold, reproducible: runs.length > 0 && passes >= cellThreshold };
}));
save();
console.log(JSON.stringify(manifest.summary, null, 2));
console.log(`Критерий ячейки: pass в ≥${cellThreshold} из ${repeats} повторов`);
for (const cell of manifest.cells) {
  console.log(`  ${cell.reproducible ? 'REPRODUCIBLE' : 'NO'}  ${cell.model} × ${cell.task}: ${cell.passes}/${cell.repeats}`);
}
process.exitCode = manifest.status === 'finished' ? 0 : 1;
