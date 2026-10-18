import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve('.');
const directory = join(root, 'bench/results', `guided-recovery-diagnostics-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const models = ['ollama:gpt-oss-20b-compactfill', 'ollama:ministral3-14b-instruct-ctx32k-compactfill', 'ollama:qwen3.8-27b-iq4-gpumax'];
const stageMinutes = 12;
const manifest = { status: 'running', repeats: 5, stageMinutes, models: [] };
const save = () => writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2));
save(); console.log(`DIAGNOSTICS ${directory}`);
for (const [i, model] of models.entries()) {
  const prefix = `diagnostics-${model.replace(/[^a-zA-Z0-9_-]/g, '-')}-`;
  const before = new Set(readdirSync(join(root, 'bench/results')));
  const entry = { model, startedAt: new Date().toISOString(), status: 'running', log: `m${i + 1}.log`, args: ['bench/src/diagnose.ts', '--model', model, '--repeat', '5', '--stage-timeout', String(stageMinutes)] };
  manifest.models.push(entry); save(); console.log(`START ${i + 1}/3 ${model}`);
  const fd = openSync(join(directory, entry.log), 'w');
  try {
    entry.exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, entry.args, { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
      child.once('error', reject); child.once('exit', done);
    });
  } finally { closeSync(fd); }
  entry.finishedAt = new Date().toISOString(); entry.status = 'complete';
  entry.reports = readdirSync(join(root, 'bench/results')).filter(file => file.startsWith(prefix) && file.endsWith('.json') && !before.has(file));
  entry.summary = entry.reports.map(file => {
    const report = JSON.parse(readFileSync(join(root, 'bench/results', file), 'utf8'));
    return { file, preflight: report.preflight.exitCode, sourceHash: report.fingerprint.sourceHash,
      cases: report.cases.map(c => ({ id: c.id, inputStatus: c.inputStatus, inputReason: c.inputReason, samples: c.samples.map(s => ({ slug: s.slug, outcome: s.outcome, timedOut: s.timedOut, problemCodes: s.problemCodes, semanticAssessment: s.semanticAssessment })) })) };
  });
  save(); console.log(`DONE ${i + 1}/3 ${model} exit=${entry.exitCode} reports=${entry.reports.length}`);
}
manifest.status = 'complete'; manifest.finishedAt = new Date().toISOString(); save();
console.log(`MANIFEST ${join(directory, 'suite.json')}`);
