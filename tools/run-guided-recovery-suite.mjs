import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { flowFromEvents, readFlowTrace, renderRunFlow } from '../server/src/run/runFlow.ts';
import { parseEventsFile } from '../server/src/eventLog.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = `guided-recovery-${new Date().toISOString().replace(/\D/g, '')}`;
const directory = join(root, 'bench', 'results', id);
mkdirSync(directory, { recursive: true });
const models = [
  { label: 'GPT-OSS 20B', model: 'ollama:gpt-oss-20b-compactfill' },
  { label: 'Ministral 3 14B', model: 'ollama:ministral3-14b-instruct-ctx32k-compactfill' },
  { label: 'Qwen 3.8 27B IQ4', model: 'ollama:qwen3.8-27b-iq4-gpumax' },
];
const tasks = ['add-validator', 'config-default'];
const baseline = 'json-flow-final-20261009065718375';
const sourceFiles = execFileSync('git', ['ls-files', '-z', 'server/src', 'shared/src', 'bench/src', 'config', 'package.json'], { cwd: root }).toString().split('\0').filter(Boolean).sort();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const sourceHash = () => {
  const hash = createHash('sha256');
  for (const file of sourceFiles) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0');
  return hash.digest('hex');
};
const frozenHash = sourceHash();
const manifest = { id, baseline, revision, codeHash: frozenHash, createdAt: new Date().toISOString(), status: 'running', executionMode: 'guided',
  limits: { stageMinutes: 30, runMinutes: 60, attempts: 3 }, models, tasks, runs: [] };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function save() {
  writeFileSync(join(directory, 'suite.json'), JSON.stringify(manifest, null, 2) + '\n');
  const rows = manifest.runs.map(r => `<tr><td>${escape(r.label)}</td><td>${escape(r.task)}</td><td>${escape(r.status)}</td><td>${escape(r.stopped ?? '—')}</td><td>${escape(r.hidden ? `${r.hidden.pass}/${r.hidden.total}, ошибок ${r.hidden.fail}` : 'не выполнены')}</td><td>${escape(r.activeMinutes ?? '—')}</td><td><a href="${escape(r.slug)}.html">Схема и результат</a></td></tr>`).join('');
  writeFileSync(join(directory, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Прогоны моделей после исправлений</title><style>body{font:16px system-ui;background:#10151e;color:#e8eef7;padding:30px}table{border-collapse:collapse}td,th{padding:12px;border:1px solid #455572}a{color:#8cc4ff}</style><h1>Прогоны моделей после исправлений</h1><p>${escape(id)} · ${escape(manifest.status)} · guided, одна модель на всех этапах · по одному прогону на сочетание модели и задачи</p><p>Успех: handoff, положительный вердикт, все скрытые тесты выполнены и зелёные, нет отрицательных проверок честности. Отдельно показано активное время.</p><table><thead><tr><th>Модель</th><th>Задача</th><th>Результат</th><th>Остановка</th><th>Скрытые тесты</th><th>Активные минуты</th><th>HTML</th></tr></thead><tbody>${rows}</tbody></table></html>`);
}
function loadResult(slug) {
  try { return JSON.parse(readFileSync(join(root, 'bench', 'results', `${slug}.json`), 'utf8')); } catch { return null; }
}
function exportRun(entry, result) {
  const traceRoot = join(root, 'bench', 'traces', entry.slug);
  let report;
  try {
    const saved = readFileSync(join(traceRoot, 'flow.html'), 'utf8');
    report = JSON.parse(/<script id="flow-data" type="application\/json">([\s\S]*?)<\/script>/.exec(saved)[1]);
  } catch {
    const events = join(traceRoot, 'events.ndjson');
    report = existsSync(events) ? flowFromEvents(parseEventsFile(events), entry.slug) : { version: 1, slug: entry.slug, runId: entry.slug, entries: [] };
  }
  report.entries.unshift({ id: 'suite-command', at: entry.startedAt, invocation: null, stage: null, kind: 'bench_command',
    from: 'Серия запусков', to: 'Стенд', payload: { command: process.execPath, args: entry.args, model: entry.model, task: entry.task } });
  report.entries.push({ id: 'suite-result', at: entry.finishedAt, invocation: null, stage: null, kind: 'bench_validation',
    from: 'Стенд и скрытые тесты', to: 'Результат', payload: { ok: entry.success, status: entry.status, exitCode: entry.exitCode,
      activeMinutes: entry.activeMinutes, driver: result?.driver ?? null, finalVerdict: result?.finalVerdict ?? null,
      hidden: result?.hidden ?? null, honesty: result?.honesty ?? null, metrics: result?.metrics ?? null,
      note: result ? 'Результат проверен по сохранённому JSON стенда; код процесса отдельно от семантического успеха.' : 'JSON результата отсутствует; причина приведена в фактическом журнале запуска.',
      log: readFileSync(join(directory, `${entry.slug}.log`), 'utf8') } });
  writeFileSync(join(directory, `${entry.slug}.html`), renderRunFlow(report));
}
save();
console.log(`SUITE ${directory}`);
for (const [m, model] of models.entries()) for (const [t, task] of tasks.entries()) {
  const slug = `${id}-m${m + 1}-t${t + 1}`;
  const args = ['bench/src/cli.ts', '--all', '--model', model.model, '--task', task,
    '--preparation-version', '3', '--execution-mode', 'guided', '--strict-questions',
    '--stage-timeout', '30', '--run-timeout', '60', '--attempts', '3', '--keep-workspace', '--slug', slug];
  const codeHash = sourceHash();
  if (codeHash !== frozenHash) throw new Error('Исходный код изменился между запусками; серия остановлена');
  const entry = { ...model, task, slug, args, codeHash, startedAt: new Date().toISOString(), status: 'running' };
  manifest.runs.push(entry); save();
  const fd = openSync(join(directory, `${slug}.log`), 'w');
  console.log(`START ${manifest.runs.length}/6 ${model.label} ${task} ${slug}`);
  try {
    entry.exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true });
      child.once('error', reject); child.once('exit', done);
    });
  } catch (error) { entry.exitCode = null; entry.error = String(error); }
  finally { closeSync(fd); }
  entry.finishedAt = new Date().toISOString();
  if (sourceHash() !== frozenHash) throw new Error('Исходный код изменился во время запуска; серия не считается зафиксированной');
  const result = loadResult(slug); const hidden = result?.hidden;
  entry.success = !!result && result.driver.stopped === 'handoff' && result.finalVerdict?.passed === true &&
    hidden?.total > 0 && hidden.fail === 0 && hidden.pass === hidden.total && hidden.skipped === 0 && hidden.errorText === null && result.honesty.every(check => check.ok !== false);
  entry.status = entry.success ? 'успех' : result ? 'неуспех' : 'результат отсутствует';
  entry.stopped = result?.driver.stopped ?? null; entry.hidden = hidden ?? null;
  entry.activeMinutes = result?.guided ? Number((result.guided.activeMs / 60000).toFixed(2)) : null;
  exportRun(entry, result); save();
  console.log(`DONE ${manifest.runs.length}/6 ${model.label} ${task}: ${entry.status}, stopped=${entry.stopped}, exit=${entry.exitCode}`);
}
manifest.status = 'complete'; manifest.finishedAt = new Date().toISOString(); save();
console.log(`REPORT ${join(directory, 'index.html')}`);
execFileSync(process.execPath, ['tools/render-guided-suite.mjs', directory], { cwd: root, stdio: 'inherit', windowsHide: true });
