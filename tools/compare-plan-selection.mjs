import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guidedSuiteSuccess } from './guided-suite-success.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const generator = option('--generator', 'ollama:gpt-oss-20b-compactfill');
const judge = option('--judge', 'ollama:qwen3.8-27b-iq4-gpumax');
const tasks = option('--tasks', 'config-default,add-validator').split(',');
const inputSnapshot = option('--input-snapshot', null);
if (inputSnapshot && tasks.length !== 1) throw new Error('--input-snapshot requires exactly one task');
const repeats = Number(option('--repeats', '1'));
const stageMinutes = Number(option('--stage-minutes', '10'));
const runMinutes = Number(option('--run-minutes', '30'));
const maxTurns = Number(option('--max-turns', '30'));
if (![repeats, stageMinutes, runMinutes, maxTurns].every(v => Number.isSafeInteger(v) && v > 0) || maxTurns < 6)
  throw new Error('Invalid experiment limits');
if (generator === judge) throw new Error('The separate judge/stronger plan control must use a different registered model');
const modes = [
  { id: 'single', flags: ['--plan-candidates', '1'] },
  { id: 'self', flags: ['--plan-candidates', '3'] },
  { id: 'separate', flags: ['--plan-candidates', '3', '--plan-judge', judge] },
  { id: 'stronger', flags: ['--plan-candidates', '1', '--control-plan', judge] },
];
const cases = tasks.flatMap(task => Array.from({ length: repeats }, (_, i) => modes.map(mode => ({ task, repeat: i + 1, mode: mode.id })))).flat();
const limits = { stageMinutes, runMinutes, maxTurns, budget: 1, attempts: 1 };
if (!args.includes('--run')) {
  console.log(JSON.stringify({ generator, judge, cases, limits, pairedInput: 'one snapshot after ask per task',
    version: 4, judges: 'two judgments with reversed order', qualityAssessment: 'full cycle + hidden checks + honesty' }, null, 2));
  process.exit(0);
}
const hash = () => {
  const digest = createHash('sha256');
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path); else digest.update(path).update(readFileSync(join(root, path)));
    }
  };
  for (const directory of ['server/src', 'shared/src', 'bench/src', 'config', 'bench/fixtures', 'bench/checks', 'bench/expected']) visit(directory);
  digest.update(readFileSync(fileURLToPath(import.meta.url)));
  return digest.digest('hex');
};
const id = `plan-selection-${new Date().toISOString().replace(/\D/gu, '')}`;
const directory = join(root, 'bench/results', id);
mkdirSync(directory, { recursive: true });
const manifest = { id, status: 'running', generator, judge, cases, limits, codeHash: hash(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  caveat: 'One repeat is a pilot, not evidence of a reliable gain. Judge strength is a hypothesis.', snapshots: [], runs: [] };
const save = () => writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2));
const launch = async (slug, extra) => {
  if (hash() !== manifest.codeHash) throw new Error('Experiment sources changed; stop rather than mix versions');
  const cli = ['bench/src/cli.ts', '--all', '--model', generator, '--execution-mode', 'guided', '--guided-engine-version', '4',
    '--preparation-version', '3', '--strict-questions', '--stage-timeout', String(stageMinutes), '--run-timeout', String(runMinutes),
    '--max-turns', String(maxTurns), '--budget', '1', '--attempts', '1', '--keep-workspace', '--slug', slug, ...extra];
  const record = { slug, args: cli, status: 'running', startedAt: new Date().toISOString() };
  manifest.runs.push(record); save(); console.log(`START ${slug}`);
  const fd = openSync(join(directory, `${slug}.log`), 'w');
  try {
    record.exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, cli, { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true });
      child.once('error', reject); child.once('exit', done);
    });
  } finally { closeSync(fd); }
  record.finishedAt = new Date().toISOString();
  record.seconds = (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
  const path = join(root, 'bench/results', `${slug}.json`);
  const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  record.status = !result ? 'no-result' : hash() !== manifest.codeHash ? 'incomparable' : result.diagnostics?.state === 'running' ? 'incomplete' : 'complete';
  record.stopped = result?.driver?.stopped ?? null;
  record.success = record.status === 'complete' && guidedSuiteSuccess(result);
  record.falseSuccess = result?.finalVerdict?.passed === true && !guidedSuiteSuccess(result);
  record.failure = result?.driver?.stages?.findLast(stage => !stage.ok)?.note ?? null;
  record.hidden = result?.hidden ?? null;
  record.plan = result?.driver?.stages?.filter(stage => stage.stage === 'plan') ?? [];
  record.planModelRequests = record.plan.reduce((sum, stage) => sum + (stage.modelRequests ?? 0), 0);
  record.tokens = result?.metrics?.stages?.reduce((sum, stage) => sum + (stage.usage?.inputTokens ?? 0) + (stage.usage?.outputTokens ?? 0), 0) ?? null;
  // Runtime audit is copied by the existing diagnostic artifact collector.
  record.selectionAudits = result?.diagnostics?.artifacts?.filter(a => a.path.includes('plan-selection/')).map(a => a.path) ?? [];
  save(); console.log(`DONE ${slug}: ${record.stopped}, success=${record.success}`);
  return record;
};
try {
  save();
  for (const task of tasks) {
    const snapshot = inputSnapshot ?? `${id}-${task}-input`;
    const bootstrap = inputSnapshot ? null : await launch(`${id}-${task}-bootstrap`, ['--task', task, '--make-snapshot', snapshot, '--snapshot-after', 'ask']);
    const snapshotFile = join(root, 'bench/snapshots', snapshot, 'snapshot.json');
    if ((!inputSnapshot && bootstrap.stopped !== 'snapshot-point') || !existsSync(snapshotFile)) {
      manifest.snapshots.push({ task, name: snapshot, status: 'failed' }); save(); continue;
    }
    const metadata = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    if (metadata.task !== task || metadata.stoppedAfterStage !== 'ask') throw new Error('Input snapshot must be from Ask of this task');
    manifest.snapshots.push({ task, name: snapshot, status: 'ready', metadata }); save();
    for (let repeat = 1; repeat <= repeats; repeat++) {
      // Rotate order across repeats to reduce systematic warm-cache effects.
      const ordered = [...modes.slice((repeat - 1) % modes.length), ...modes.slice(0, (repeat - 1) % modes.length)];
      for (const mode of ordered) {
        const record = await launch(`${id}-${task}-${mode.id}-r${repeat}`, ['--task', task, '--from-snapshot', snapshot, ...mode.flags]);
        Object.assign(record, { task, repeat, mode: mode.id, snapshot }); save();
      }
    }
  }
  manifest.status = manifest.snapshots.some(s => s.status !== 'ready') || manifest.runs.some(r => r.status !== 'complete') ? 'incomplete' : 'complete';
} catch (error) {
  manifest.status = 'stopped'; manifest.error = String(error); process.exitCode = 1;
} finally {
  manifest.finishedAt = new Date().toISOString();
  manifest.summary = modes.map(mode => {
    const runs = manifest.runs.filter(r => r.mode === mode.id);
    return { mode: mode.id, runs: runs.length, success: runs.filter(r => r.success).length,
      falseSuccess: runs.filter(r => r.falseSuccess).length, seconds: runs.reduce((n, r) => n + r.seconds, 0),
      planModelRequests: runs.reduce((n, r) => n + (r.planModelRequests ?? 0), 0),
      tokens: runs.reduce((n, r) => n + (r.tokens ?? 0), 0) };
  });
  manifest.interpretation = manifest.summary.every(s => s.planModelRequests === 0)
    ? 'No plan generation was measured. Upstream blocks/launch failures cannot establish arbitration quality.'
    : 'Pilot only; improvement requires repeated comparable runs and holdout tasks.';
  save(); console.log(JSON.stringify({ directory, status: manifest.status, summary: manifest.summary }, null, 2));
}
