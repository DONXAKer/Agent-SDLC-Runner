/** Reproducible staged validation; benchmark definitions stay out of runtime policies. */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config/load.ts';
import { sourceFingerprint } from './src/taskLoopPilot.ts';
import { assessGuidedValidation } from './src/guidedValidation.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const flags = process.argv.slice(2);
const execute = flags.includes('--run');
const resume = flags.includes('--resume');
const values = {};
for (let i = 0; i < flags.length; i++) {
  if (['--run', '--resume'].includes(flags[i])) continue;
  if (!['--phase', '--output', '--pilot', '--model'].includes(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error('Usage: --phase pilot|matrix|transfer [--pilot manifest.json] [--model id] [--output directory] [--run] [--resume]');
  values[flags[i].slice(2)] = flags[++i];
}
const phase = values.phase ?? 'pilot';
if (!['pilot', 'matrix', 'transfer'].includes(phase)) throw new Error('Unknown validation phase');
const models = ['ollama:devstral-small-2', 'ollama:mellum2-12b-instruct-q6', 'ollama:gpt-oss-20b-ctx32k', 'ollama:qwen3.8-27b-iq4-gpumax', 'ollama:ministral3-14b-instruct-ctx32k'];
const tasks = ['add-validator', 'config-default', 'rename-field', 'idempotent-retry', 'vat-rounding'];
const pilot = [['ollama:mellum2-12b-instruct-q6', 'config-default'], ['ollama:mellum2-12b-instruct-q6', 'rename-field'],
  ['ollama:gpt-oss-20b-ctx32k', 'add-validator'], ['ollama:qwen3.8-27b-iq4-gpumax', 'vat-rounding'],
  ['ollama:qwen3.8-27b-iq4-gpumax', 'rename-field'], ['ollama:ministral3-14b-instruct-ctx32k', 'config-default']];
const config = loadConfig();
function fingerprint() {
  const hash = createHash('sha256').update(sourceFingerprint(root));
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Symlink in methodology input: ${entry.name}`);
      const file = join(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '.git') walk(file); }
      else hash.update(file).update(readFileSync(file));
    }
  };
  for (const path of [join(config.runner.methodologyDir, 'templates'), config.runner.skillsDir, config.runner.agentsDir]) walk(path);
  hash.update(readFileSync(import.meta.filename));
  return hash.digest('hex');
}
const sourceHash = fingerprint();
let prior;
if (phase !== 'pilot') {
  if (!values.pilot) throw new Error('Matrix/transfer requires the pilot manifest');
  prior = JSON.parse(readFileSync(resolve(values.pilot), 'utf8'));
  if (prior.phase !== 'pilot' || prior.sourceHash !== sourceHash || prior.status !== 'completed') throw new Error('Pilot is incomplete or belongs to different source inputs');
  const paired = new Map();
  for (const cell of prior.cells) {
    const key = `${cell.model}\0${cell.task}`;
    paired.set(key, [...(paired.get(key) ?? []), cell]);
  }
  const passedPairs = [...paired.values()].filter(cells => cells.length === 2 && cells.every(c => c.success));
  if (!passedPairs.length) throw new Error('Pilot gate: no model/task pair completed both full runs successfully');
  if (prior.cells.some(c => c.diagnosis === 'runner-defect') || prior.analysis?.runnerRegressionsCleared !== true)
    throw new Error('Pilot gate: explicit analysis must confirm runnerRegressionsCleared after reviewing failures');
  if (phase === 'transfer' && (!values.model || !passedPairs.some(pair => pair[0].model === values.model))) throw new Error('Transfer requires a model that passed both pilot repeats');
}
const pairs = phase === 'pilot' ? pilot : phase === 'matrix' ? models.flatMap(model => tasks.map(task => [model, task])) :
  ['guided-transfer-window', 'guided-transfer-segments', 'guided-transfer-message'].map(task => [values.model, task]);
const id = `guided-validation-${phase}-${new Date().toISOString().replace(/\D/g, '')}`;
const output = resolve(values.output ?? join(root, 'bench/results', id));
const statusPath = join(output, 'manifest.json');
let manifest;
if (resume) {
  manifest = JSON.parse(readFileSync(statusPath, 'utf8'));
  if (manifest.sourceHash !== sourceHash || manifest.phase !== phase) throw new Error('Cannot resume changed sources or another phase');
} else {
  if (existsSync(output) && readdirSync(output).length) throw new Error('Output must be new or empty');
  mkdirSync(output, { recursive: true });
  const cells = pairs.flatMap(([model, task], i) => Array.from({ length: phase === 'pilot' ? 2 : 1 }, (_, repeat) => ({ model, task, repeat: repeat + 1,
    slug: `${id}-${i + 1}-r${repeat + 1}`, status: 'pending' })));
  manifest = { id, phase, sourceHash, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    createdAt: new Date().toISOString(), status: 'planned', protocol: { executionMode: 'guided', guidedEngineVersion: 4, preparationVersion: 3, strictQuestions: true, attempts: 3, stageMinutes: 20, runMinutes: 45 },
    models: [...new Set(pairs.map(pair => pair[0]))].map(id => {
      const m = config.models.models.find(m => m.id === id); if (!m) throw new Error(`Unknown model ${id}`);
      return { id, tag: m.model, contextWindow: m.contextWindow, params: m.params };
    }),
    limitations: ['Pilot/matrix use known tasks; transfer cases are new but are not a statistical reliability estimate', 'Approval automation is not a live human signature', 'Failure attribution requires explicit analysis; it is never inferred from a message pattern'], cells };
}
const save = () => writeFileSync(statusPath, JSON.stringify(manifest, null, 2) + '\n');
function summarize() {
  const counts = {};
  for (const cell of manifest.cells) counts[cell.status] = (counts[cell.status] ?? 0) + 1;
  const clean = text => String(text ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  writeFileSync(join(output, 'summary.ru.md'), `# Guided validation: ${phase}\n\nСерия: **${manifest.status}**. Успех: **${manifest.cells.filter(c => c.success).length}/${manifest.cells.length}**.\n\nСтатусы: ${JSON.stringify(counts)}.\n\n| Модель | Задача | Повтор | Статус | Этап отказа | Причина |\n|---|---|---|---|---|---|\n` + manifest.cells.map(c => `| ${c.model} | ${c.task} | ${c.repeat} | ${c.status} | ${c.failedStage ?? '—'} | ${clean(c.reason)} |`).join('\n') + '\n');
}
save(); summarize();
if (!execute) { console.log(`Planned ${manifest.cells.length} invocations: ${statusPath}. Add --run to execute.`); process.exit(0); }
manifest.status = 'running'; save();
let child, cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cancelled = true; child?.kill(signal); });
let previousTag;
try {
  for (const cell of manifest.cells) {
    if (!['pending', 'running', 'interrupted'].includes(cell.status)) continue;
    if (cancelled || fingerprint() !== sourceHash) { manifest.status = cancelled ? 'cancelled' : 'source-changed'; break; }
    if (cell.status !== 'pending') {
      cell.previousInvocations = [...(cell.previousInvocations ?? []), { ...cell, previousInvocations: undefined }];
      cell.slug = `${cell.slug}-resume-${Date.now()}`;
    }
    const tag = manifest.models.find(m => m.id === cell.model).tag;
    if (previousTag && previousTag !== tag) spawnSync('ollama', ['stop', previousTag], { cwd: root, windowsHide: true, stdio: 'ignore' });
    previousTag = tag;
    cell.status = 'running'; cell.startedAt = new Date().toISOString(); save(); summarize();
    const resultPath = join(root, 'bench/results', `${cell.slug}.json`);
    if (existsSync(resultPath)) throw new Error(`Refusing to overwrite existing result ${resultPath}; use a fresh invocation`);
    const logPath = join(output, `${cell.slug}.log`); const fd = openSync(logPath, 'wx');
    console.log(`START ${cell.model} ${cell.task} repeat=${cell.repeat}`);
    let code;
    try {
      code = await new Promise((done, reject) => {
        child = spawn(process.execPath, ['bench/src/cli.ts', '--all', '--model', cell.model, '--task', cell.task,
          '--execution-mode', 'guided', '--guided-engine-version', '4', '--preparation-version', '3', '--strict-questions',
          '--attempts', '3', '--stage-timeout', '20', '--run-timeout', '45', '--slug', cell.slug, '--keep-workspace'],
        { cwd: root, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, SDLC_RAW_LOG_DIR: join(output, 'raw') } });
        child.once('error', reject); child.once('close', done);
      });
    } finally { closeSync(fd); child = undefined; }
    cell.finishedAt = new Date().toISOString();
    let result = null;
    if (existsSync(resultPath)) result = JSON.parse(readFileSync(resultPath, 'utf8'));
    const preflightPath = join(root, 'bench/results', `${cell.slug}.preflight.json`);
    const preflight = existsSync(preflightPath) ? JSON.parse(readFileSync(preflightPath, 'utf8')) : undefined;
    Object.assign(cell, assessGuidedValidation(result, cell, code, preflight));
    cell.log = logPath; if (result) cell.resultPath = resultPath;
    if (cancelled) cell.status = 'interrupted';
    save(); summarize(); console.log(`DONE ${cell.status} ${cell.reason ?? ''}`);
  }
  if (manifest.status === 'running' && fingerprint() !== sourceHash) manifest.status = 'source-changed';
} catch (error) {
  manifest.status = 'launcher-error'; manifest.error = String(error); throw error;
} finally {
  if (previousTag) spawnSync('ollama', ['stop', previousTag], { cwd: root, windowsHide: true, stdio: 'ignore' });
  if (manifest.status === 'running') manifest.status = cancelled ? 'cancelled' : 'completed';
  manifest.finishedAt = new Date().toISOString();
  manifest.qualityPassed = manifest.cells.every(c => c.success === true);
  save(); summarize(); console.log(`Manifest: ${statusPath}`);
}
process.exitCode = manifest.status === 'completed' && manifest.qualityPassed ? 0 : 1;
