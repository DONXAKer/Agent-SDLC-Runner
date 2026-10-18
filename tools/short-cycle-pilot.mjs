import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { applyPilotFiles } from '../tools/pilot-files.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, '.tmp', 'short-cycle-pilot');
const model = process.argv[2];
const taskId = process.argv[3] ?? 'add-validator';
const replayPath = process.argv[4] ?? null;
if (!model) throw new Error('Usage: node .tmp/short-cycle-pilot.mjs <ollama-model-tag> [task-id]');

const taskConfigs = {
  'add-validator': {
    fixture: 'billing',
    allowed: ['src/validate.ts', 'src/index.ts', 'test/validateCustomer.test.ts'],
    required: ['src/validate.ts', 'src/index.ts', 'test/validateCustomer.test.ts'],
    sources: ['src/index.ts', 'src/customer.ts', 'src/config.ts', 'src/invoice.ts', 'src/lines.ts', 'src/money.ts', 'test/invoice.test.ts', 'test/lines.test.ts', 'test/money.test.ts'],
  },
  'holdout-winter-surcharge': {
    fixture: 'fleet',
    allowed: ['src/trip.ts', 'src/index.ts', 'test/winterFuel.test.ts'],
    required: ['src/trip.ts', 'src/index.ts', 'test/winterFuel.test.ts'],
    sources: ['src/index.ts', 'src/rates.ts', 'src/trip.ts', 'test/rates.test.ts', 'test/trip.test.ts'],
  },
};
const taskConfig = taskConfigs[taskId];
if (!taskConfig) throw new Error(`Unsupported task: ${taskId}`);
const fixture = join(root, 'bench', 'fixtures', taskConfig.fixture);
const task = readFileSync(join(fixture, `task-${taskId}.md`), 'utf8');
const sourceFiles = taskConfig.sources;
const sources = sourceFiles.map(path => `### ${path}\n${readFileSync(join(fixture, path), 'utf8')}`).join('\n');
const runId = `${Date.now()}-${model.replace(/[^a-zA-Z0-9.-]/g, '-')}-${randomUUID().slice(0, 8)}`;
const target = join(outRoot, runId, 'project');
const recordPath = join(outRoot, runId, 'record.json');
mkdirSync(dirname(target), { recursive: true });
cpSync(fixture, target, { recursive: true });

const started = new Date().toISOString();
const replay = replayPath ? JSON.parse(readFileSync(resolve(replayPath), 'utf8')) : null;
if (replay && (replay.model !== model || replay.taskId !== taskId)) throw new Error('Replay model/task mismatch');
const record = { model, taskId, started, method: 'visible checks, one repair, hidden checks only after final patch', replayOf: replayPath,
  taskHash: createHash('sha256').update(task).digest('hex'), sourceHash: createHash('sha256').update(sources).digest('hex'),
  runnerHash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), attempts: [] };
cpSync(target, join(outRoot, runId, 'baseline'), { recursive: true });

async function generate(messages) {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record.attempts.at(-1).request = {
      model,
      stream: false,
      format: 'json',
      ...(model.startsWith('qwen3.8-') ? { think: false } : {}),
      options: {
        num_ctx: model.includes('ctx32k') ? 32768 : 16384,
        num_predict: model.startsWith('qwen3.8-') ? 4096 : 8192,
        temperature: 0.2,
      },
      messages,
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const body = await response.text();
  record.attempts.at(-1).rawResponse = body;
  record.attempts.at(-1).httpStatus = response.status;
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 1200)}`);
  const envelope = JSON.parse(body);
  record.attempts.at(-1).finishReason = envelope.done_reason ?? null;
  record.attempts.at(-1).thinking = envelope.message?.thinking ?? null;
  record.attempts.at(-1).response = envelope.message?.content ?? '';
  record.attempts.at(-1).usage = { promptTokens: envelope.prompt_eval_count ?? null, outputTokens: envelope.eval_count ?? null, elapsedNs: envelope.total_duration ?? null };
  return JSON.parse(envelope.message.content);
}

function apply(answer) { applyPilotFiles(target, taskConfig.required, answer); }

function run(command, args, env = {}) {
  try {
    const stdout = execFileSync(command, args, { cwd: target, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: stdout.slice(-12000) };
  } catch (error) {
    return { ok: false, exitCode: error.status ?? null, output: `${error.stdout ?? ''}\n${error.stderr ?? ''}`.slice(-12000) };
  }
}

const system = [
  'You are implementing a small TypeScript task in an isolated project copy.',
  'Return only a JSON object: {"files":[{"path":"...","content":"..."}]}.',
  `Return exactly these complete files: ${taskConfig.required.join(', ')}.`,
  'Do not edit existing tests or any other file. Preserve existing exports and behavior.',
  'Read the task and supplied source carefully. Implement every requirement, including edge cases and a real test file.',
].join(' ');
const initial = [
  { role: 'system', content: system },
  { role: 'user', content: `TASK\n${task}\n\nSOURCE FILES\n${sources}` },
];

for (let number = 1; number <= 2; number++) {
  record.attempts.push({ number, startedAt: new Date().toISOString() });
  const t0 = performance.now();
  try {
    const answer = replayPath && number === 1 ? JSON.parse(record.attempts.at(-1).response = replay.attempts[0].response) : await generate(number === 1 ? initial : [
      ...initial,
      { role: 'assistant', content: record.attempts[0].response },
      { role: 'user', content: `The first patch was applied in the isolated copy. These real project checks failed:\n${record.attempts[0].checks.map(c => `${c.name}:\n${c.output}`).join('\n\n')}\n\nReturn complete corrected contents for the same three allowed files only. Fix the failures while preserving the task contract.` },
    ]);
    apply(answer);
    cpSync(target, join(outRoot, runId, `attempt-${number}`), { recursive: true });
    delete record.attempts.at(-1).error;
    const checks = [
      { name: 'build', ...run(process.execPath, ['scripts/build-check.mjs']) },
      { name: 'visible-tests', ...run(process.execPath, ['--test']) },
    ];
    record.attempts.at(-1).checks = checks;
    record.attempts.at(-1).elapsedMs = Math.round(performance.now() - t0);
    record.attempts.at(-1).passed = checks.every(c => c.ok);
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ runId, model, attempt: number, passed: record.attempts.at(-1).passed, checks: checks.map(c => ({ name: c.name, ok: c.ok, exitCode: c.exitCode })), promptTokens: record.attempts.at(-1).usage?.promptTokens, outputTokens: record.attempts.at(-1).usage?.outputTokens, elapsedMs: record.attempts.at(-1).elapsedMs, recordPath }, null, 2));
    if (record.attempts.at(-1).passed) break;
  } catch (error) {
    record.attempts.at(-1).error = String(error);
    record.attempts.at(-1).elapsedMs = Math.round(performance.now() - t0);
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.error(JSON.stringify({ runId, model, attempt: number, error: String(error), recordPath }, null, 2));
    process.exitCode = 1;
    break;
  }
}
record.hidden = run(process.execPath, ['--test', join(root, 'bench', 'checks', 'hidden', `${taskId}.hidden.mjs`)], { BENCH_TARGET_DIR: target });
record.passed = record.attempts.at(-1)?.passed === true && record.hidden.ok;
if (!record.passed) process.exitCode = 1;
record.finished = new Date().toISOString();
writeFileSync(recordPath, JSON.stringify(record, null, 2));
