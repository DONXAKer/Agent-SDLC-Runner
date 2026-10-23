import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { decisionCases, requestFor, probabilityOf, metrics, choiceRequest, choiceOf } from './cases.mjs';
import { renderComparison } from './report.mjs';
import { loadConfig } from '../../server/src/config/load.ts';
import { OpenAiCompatProvider } from '../../server/src/provider/OpenAiCompatProvider.ts';
import { probeModel, PREFLIGHT_CASES } from '../../server/src/probe.ts';
import { assessGuidedValidation } from '../src/guidedValidation.ts';
import { sourceFingerprint } from '../src/taskLoopPilot.ts';

const root = resolve('.');
const preparation = resolve('.tmp/model-comparison-20261019');
const runtimePath = join(preparation, 'runtime.json');
const runtime = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')) : {};
const linuxEnv = name => runtime[name] ?? relative(root, join(preparation, name)).replaceAll('\\', '/');
const prepared = JSON.parse(readFileSync(join(preparation, 'preparation.json'), 'utf8'));
for (const model of prepared.models) if (model.status === 'downloaded' && model.files.some(f => !f.actualSha256 || !f.downloaded))
  throw new Error(`Unverified weights for ${model.id}; run prepare.mjs --verify first`);
const output = resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? `bench/results/model-comparison-${new Date().toISOString().replace(/\D/g, '')}`);
if (existsSync(output) && readdirSync(output).length) throw new Error('Use a new output directory');
mkdirSync(output, { recursive: true });
const config = loadConfig();
const readiness = [];
if (!process.argv.includes('--dry-run')) {
  for (let sample = 0; sample < 3; sample++) {
    const gpu = execFileSync('nvidia-smi', ['--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
      .trim().split(/\r?\n/).map(line => line.split(',').map(v => Number(v.trim())));
    readiness.push(gpu);
    if (gpu.length !== 2 || gpu[0][0] < 10500 || gpu[1][0] < 6500 || gpu[0][1] > 10 || gpu[1][1] > 25)
      throw new Error(`GPU not idle enough for the requested clean comparison (free MiB/utilization): ${JSON.stringify(gpu)}. No timer or model request started.`);
    if (sample < 2) await new Promise(done => setTimeout(done, 1000));
  }
}
const started = Date.now();
const decisionGpu = execFileSync('nvidia-smi', ['--query-gpu=uuid,memory.total,name', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
  .trim().split(/\r?\n/).map(line => { const [uuid, memory, name] = line.split(',').map(v => v.trim()); return { uuid, memoryMiB: Number(memory), name }; })
  .sort((a,b) => b.memoryMiB - a.memoryMiB)[0];
if (!decisionGpu || !/^GPU-[a-f0-9-]+$/i.test(decisionGpu.uuid)) throw new Error('Cannot identify physical decision GPU');
const judgesOnly = process.argv.includes('--judges-only');
const diagnosticOnly = process.argv.includes('--diagnostic-only');
const holdoutOnly = process.argv.includes('--holdout-only');
if (diagnosticOnly && holdoutOnly) throw new Error('Choose diagnostic-only or holdout-only');
const standardBackend = process.argv.find(a => a.startsWith('--standard-backend='))?.slice('--standard-backend='.length) ?? 'auto';
if (!['auto', 'torch'].includes(standardBackend)) throw new Error('Unsupported StandardOne kernel backend');
const judgeIdsArgument = process.argv.find(a => a.startsWith('--judge-ids='));
const judgeIds = judgeIdsArgument ? new Set(judgeIdsArgument.slice('--judge-ids='.length).split(',')) : null;
const deadlineArgument = process.argv.find(a => a.startsWith('--deadline='));
const requestedDeadline = deadlineArgument ? Date.parse(deadlineArgument.slice('--deadline='.length)) : started + 3 * 60 * 60_000;
if (!Number.isFinite(requestedDeadline) || requestedDeadline <= started) throw new Error('Deadline must be a future ISO timestamp');
const deadline = Math.min(requestedDeadline, started + 3 * 60 * 60_000);
const screeningDeadline = Math.min(started + 90 * 60_000, deadline);
const fullDeadline = Math.min(started + 150 * 60_000, deadline);
const sourceHash = () => {
  const hash = createHash('sha256').update(sourceFingerprint(root));
  for (const file of readdirSync('bench/model-comparison').sort()) hash.update(file).update(readFileSync(join('bench/model-comparison', file)));
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      if (entry.isSymbolicLink()) throw new Error('Methodology symlinks are not supported');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path); else hash.update(path).update(readFileSync(path));
    }
  };
  for (const directory of [join(config.runner.methodologyDir, 'templates'), config.runner.skillsDir, config.runner.agentsDir]) visit(directory);
  return hash.digest('hex');
};
const manifest = { status: 'running', startedAt: new Date(started).toISOString(), deadline: new Date(deadline).toISOString(), sourceHash: sourceHash(),
  preparation: prepared, decisionGpu, standardBackend, budgetMinutes: (deadline - started) / 60_000, mode: judgesOnly ? 'judges-only' : 'all', seed: { status: 'not-applicable', reason: 'No fixed generation seed in active model profiles or provider defaults; benchmark --seed injects defects.' },
  candidates: [], fullRuns: [], decisions: [], limitations: [
    'Handwritten finite RU/EN fixtures, not a statistical reliability estimate.',
    'Decision confidence is conditional on the question and does not authorize actions.',
    'A short probe is not a successful guided workflow.',
    'Incomplete and unavailable candidates are not counted as incorrect model answers.',
    'The 4060 drives the Windows desktop; light display load remains and is recorded in startup samples.',
  ] };
manifest.revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
manifest.readiness = readiness;
manifest.environment = { node: process.version, ollama: execFileSync('ollama', ['--version'], { encoding: 'utf8' }).trim(),
  runtime,
  packages: Object.fromEntries(['env-decision', 'env-standard', 'env-native'].map(name => {
    const file = join(preparation, `${name}.freeze.txt`);
    return [name, existsSync(file) ? readFileSync(file, 'utf8') : 'not captured'];
  })) };
for (const file of ['pylock.decision.toml', 'decision-wheels.json', 'wheels-verified.json'])
  if (existsSync(join(preparation, file))) cpSync(join(preparation, file), join(output, file));
const save = () => writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const trace = (file, record) => appendFileSync(join(output, file), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
const hardware = () => execFileSync('nvidia-smi', ['--query-gpu=index,name,memory.used,memory.total', '--format=csv,noheader'], { encoding: 'utf8' }).trim();
const delay = ms => new Promise(done => setTimeout(done, ms));
let cancelled = false, budgetExpired = false;
const children = new Set();
const linuxPidFiles = new Map();
function stop(child) {
  if (!child || child.exitCode !== null) return;
  const pidFile = linuxPidFiles.get(child);
  if (pidFile && existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf8').trim();
    if (/^[1-9][0-9]*$/.test(pid)) {
      try { execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'kill', '-TERM', '--', `-${pid}`], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
  }
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
  } else child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cancelled = true; for (const child of children) stop(child); });
const hardDeadline = setTimeout(() => { budgetExpired = true; for (const child of children) stop(child); }, deadline - Date.now());
function active(until = deadline) {
  if (cancelled) throw new Error('Cancelled');
  if (budgetExpired || Date.now() >= Math.min(until, deadline)) throw new Error('Phase budget exhausted');
  if (sourceHash() !== manifest.sourceHash) throw new Error('Source inputs changed');
}
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, ...options });
  children.add(child); child.once('exit', () => children.delete(child));
  return child;
}
function startLinux(args, id, options) {
  const pidFile = join(output, `${id}.linux.pid`);
  const child = start('wsl.exe', ['-d', 'Ubuntu', '--', 'setsid', '--wait', 'bash', 'bench/model-comparison/linux-job.sh',
    relative(root, pidFile).replaceAll('\\', '/'), ...args], options);
  linuxPidFiles.set(child, pidFile);
  return child;
}
async function command(command, args, timeoutMs, env = process.env, log = 'commands.log') {
  const fd = openSync(join(output, log), 'a');
  const child = start(command, args, { env, stdio: ['ignore', fd, fd] });
  const timeout = setTimeout(() => stop(child), timeoutMs);
  try { return await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }); }
  finally { clearTimeout(timeout); closeSync(fd); }
}
async function post(path, body, timeoutMs = 60_000, port = 11435) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now()))) });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
let ollama;
async function ollamaStop() {
  if (!ollama) return;
  try {
    const ps = await fetch('http://127.0.0.1:11435/api/ps', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
    for (const model of ps.models ?? []) await post('/api/generate', { model: model.name, keep_alive: 0 }, 5000);
  } catch { /* process can already be down */ }
  stop(ollama); ollama = undefined; await delay(1000);
}
async function ollamaStart(cache = 'f16') {
  await ollamaStop();
  let occupied = false;
  try { await fetch('http://127.0.0.1:11435/api/version', { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  if (occupied) throw new Error('Port 11435 is already owned by another server; refusing to use its settings');
  const fd = openSync(join(output, `ollama-${cache}.log`), 'a');
  const modelsPath = process.env.OLLAMA_MODELS || execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')"], { encoding: 'utf8' }).trim();
  ollama = start('ollama', ['serve'], { env: { ...process.env, ...(modelsPath ? { OLLAMA_MODELS: modelsPath } : {}),
    OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: cache }, stdio: ['ignore', fd, fd] });
  ollama.once('close', () => closeSync(fd));
  for (let i = 0; i < 100; i++) {
    if (ollama.exitCode !== null) throw new Error('Isolated Ollama failed to start');
    try { if ((await fetch('http://127.0.0.1:11435/api/version', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(200);
  }
  throw new Error('Isolated Ollama readiness timeout');
}
async function warmup(tag) {
  const result = await post('/api/generate', { model: tag, prompt: 'Reply OK.', stream: false, think: false,
    options: { num_ctx: 32768, num_predict: 1 }, keep_alive: '5m' }, 300_000);
  const ps = await fetch('http://127.0.0.1:11435/api/ps').then(r => r.json());
  const model = ps.models?.find(m => m.name === tag || m.name === `${tag}:latest`);
  if (!model || !(model.size > 0)) throw new Error('No verified loaded-model memory record');
  return { result, model, hardware: hardware(), fullyGpu: model.size_vram / model.size >= 0.99 };
}
const copiedConfig = join(output, 'config');
cpSync(config.dir, copiedConfig, { recursive: true });
const modelConfigPath = join(copiedConfig, 'models.json');
const modelConfig = JSON.parse(readFileSync(modelConfigPath, 'utf8'));
modelConfig.providers.ollama.baseUrl = 'http://127.0.0.1:11435/v1';
// Preserve the control's parameters and change exactly the selected setting.
const base = modelConfig.models.find(m => m.id === 'ollama:qwen3.8-27b-iq4-gpumax');
if (!base) throw new Error('Missing Qwen control profile');
const controlTagPath = join(preparation, 'control-tag.json');
const controlTag = JSON.parse(readFileSync(controlTagPath, 'utf8'));
const sourceStops = [...controlTag.parameters.matchAll(/^stop\s+(.+)$/gm)].map(match => JSON.parse(match[1]));
const compatibleStops = sourceStops.filter(stop => !['<think>', '</think>'].includes(stop));
const compatibleTag = 'comparison-qwen-compatible-ctx32k';
manifest.controlTag = controlTag;
manifest.sampling = { temperature: 0.15, reason: 'Same explicit temperature as the installed Qwen control tag; not an optimality claim for every model.' };
const variants = [
  { id: 'qwen-original-f16', tag: base.model, cache: 'f16', params: { ...base.params, temperature: 0.15, reasoning_effort: 'none' }, control: true },
  { id: 'qwen-off-f16', tag: compatibleTag, compatibleStops: true, cache: 'f16', params: { ...base.params, temperature: 0.15, reasoning_effort: 'none' } },
  { id: 'qwen-on-f16', tag: compatibleTag, compatibleStops: true, cache: 'f16', params: { ...base.params, temperature: 0.15, reasoning_effort: 'low' } },
  { id: 'qwen-off-q8', tag: compatibleTag, compatibleStops: true, cache: 'q8_0', params: { ...base.params, temperature: 0.15, reasoning_effort: 'none' } },
  ...['neohorse', 'blend'].map(id => ({ id, tag: `comparison-${id}-ctx32k`, cache: 'f16', params: { reasoning_effort: 'low', temperature: 0.15, max_tokens: 4096 }, preparedId: id })),
];
for (const variant of variants) {
  variant.modelId = `ollama:comparison-${variant.id}`;
  modelConfig.models.push({ ...base, id: variant.modelId, model: variant.tag, params: variant.params });
}
writeFileSync(modelConfigPath, JSON.stringify(modelConfig, null, 2) + '\n');
manifest.hardware = hardware(); save();
if (process.argv.includes('--dry-run')) { manifest.status = 'planned'; manifest.variants = variants; save(); clearTimeout(hardDeadline); console.log(output); process.exit(0); }
process.env.SDLC_RAW_LOG_DIR = join(output, 'raw');

async function screenExecutor(variant) {
  const cell = { ...variant, role: 'executor', status: 'running', startedAt: new Date().toISOString() };
  manifest.candidates.push(cell); save(); console.log(`SCREEN ${variant.id}`);
  try {
    active(screeningDeadline);
    await ollamaStart(variant.cache);
    if (variant.compatibleStops) {
      cell.createdTag = await post('/api/create', { model: variant.tag, from: base.model, parameters: { stop: compatibleStops }, stream: false }, 300_000);
      const shown = await post('/api/show', { model: variant.tag });
      cell.tagParameters = shown.parameters;
      const actual = [...shown.parameters.matchAll(/^stop\s+(.+)$/gm)].map(match => JSON.parse(match[1]));
      if (actual.some(stop => ['<think>', '</think>'].includes(stop))) throw new Error('Backend retained the incompatible thinking stop; comparison invalid');
      if (JSON.stringify([...actual].sort()) !== JSON.stringify([...compatibleStops].sort())) throw new Error('Backend changed other stop parameters; comparison invalid');
    }
    if (variant.preparedId) {
      const model = prepared.models.find(m => m.id === variant.preparedId);
      if (model?.status !== 'downloaded') throw new Error(`Weights unavailable: ${model?.reason ?? model?.status}`);
      const modelfile = join(output, `${variant.id}.Modelfile`);
      writeFileSync(modelfile, `FROM ${join(model.directory, model.files.find(f => f.name.endsWith('.gguf')).name).replaceAll('\\', '/')}\nPARAMETER num_ctx 32768\nPARAMETER num_gpu 999\n`);
      const code = await command('ollama', ['create', variant.tag, '-f', modelfile], 300_000,
        { ...process.env, OLLAMA_HOST: '127.0.0.1:11435' });
      if (code !== 0) throw new Error(`Model import exit ${code}`);
    }
    cell.warmup = await warmup(variant.tag);
    cell.tagParameters ??= (await post('/api/show', { model: variant.tag })).parameters;
    save();
    if (!cell.warmup.fullyGpu) { cell.status = 'environment-offload'; return; }
    const parameterRequest = { model: variant.tag, stream: false, messages: [{ role: 'user', content: 'A sequence starts at 3. Double it, subtract 1, double again. Reply with the final integer.' }], ...variant.params, max_tokens: 1024 };
    const parameterResponse = await post('/v1/chat/completions', parameterRequest);
    trace(`${variant.id}.parameter-check.ndjson`, { request: parameterRequest, response: parameterResponse });
    const message = parameterResponse.choices?.[0]?.message;
    const reportedReasoning = message?.reasoning ?? message?.reasoning_content ?? '';
    cell.reasoningObservation = { requested: variant.params.reasoning_effort, reportedCharacters: reportedReasoning.length,
      verified: variant.params.reasoning_effort === 'none' ? reportedReasoning.length === 0 : reportedReasoning.length > 0 };
    const engineLog = readFileSync(join(output, `ollama-${variant.cache}.log`), 'utf8');
    cell.cacheObservation = { requested: variant.cache,
      matches: engineLog.split(/\r?\n/).filter(line => /type_[kv]|cache.type|kv.*dtype/i.test(line)).slice(-12) };
    cell.cacheObservation.verified = variant.cache === 'f16' || cell.cacheObservation.matches.some(line => /q8_0/i.test(line));
    const providerDef = { ...config.models.providers.ollama, baseUrl: 'http://127.0.0.1:11435/v1' };
    const warnings = [];
    const provider = new OpenAiCompatProvider({ name: 'ollama', baseUrl: providerDef.baseUrl, apiKey: null, timeoutMs: 60_000,
      maxTokens: providerDef.maxTokens, onWarn: warning => warnings.push(warning), trace: { slug: variant.id, stage: 'probe', mode: 'loop' } });
    const wrapped = { ...provider, name: provider.name, async chat(request) {
      active(screeningDeadline);
      const response = await provider.chat(request);
      trace(`${variant.id}.requests.ndjson`, { request, response });
      return response;
    } };
    cell.probe = await probeModel({ provider: wrapped, model: variant.tag, params: variant.params,
      caseTimeoutMs: 60_000, cases: PREFLIGHT_CASES, role: 'chunk' });
    cell.warnings = warnings;
    cell.correct = cell.probe.cases.filter(c => c.ok).length;
    cell.total = cell.probe.cases.length;
    cell.status = warnings.some(w => /thinking|reasoning/i.test(w)) || !cell.reasoningObservation.verified || !cell.cacheObservation.verified
      ? 'parameter-unverified' : cell.probe.cases.every(c => c.ok) ? 'screen-passed' : 'screen-failed';
  } catch (e) { cell.status = 'unavailable'; cell.error = String(e); }
  finally { cell.finishedAt = new Date().toISOString(); save(); await ollamaStop(); console.log(`DONE ${variant.id} ${cell.status}`); }
}

function wslPath(path) { return relative(root, path).replaceAll('\\', '/'); }
async function pythonBridge(model, phaseDeadline) {
  const child = startLinux(['env', `CUDA_VISIBLE_DEVICES=${decisionGpu.uuid}`,
    `${linuxEnv('env-decision')}/bin/python`, '-u', 'bench/model-comparison/decision-worker.py', model.kind, wslPath(model.directory)], model.id,
  { stdio: ['pipe', 'pipe', 'pipe'] });
  return jsonBridge(child, model.id, phaseDeadline);
}
async function jsonBridge(child, id, phaseDeadline) {
  child.stderr.on('data', data => appendFileSync(join(output, `${id}.stderr.log`), data));
  const lines = createInterface({ input: child.stdout });
  const queue = []; const pending = [];
  const deliver = value => pending.length ? pending.shift()(value) : queue.push(value);
  lines.on('line', line => { try { deliver(JSON.parse(line)); } catch { trace(`${id}.stdout.ndjson`, { line }); } });
  child.on('close', code => deliver({ error: `Worker exited ${code}` }));
  const next = ms => new Promise((done, reject) => {
    if (queue.length) return done(queue.shift());
    const timer = setTimeout(() => { stop(child); reject(new Error('Worker timeout')); }, ms);
    pending.push(value => { clearTimeout(timer); done(value); });
  });
  try {
    const ready = await next(Math.max(1, Math.min(300_000, phaseDeadline - Date.now())));
    if (!ready.ready) throw new Error(ready.error ?? 'Worker not ready');
    return { close: () => stop(child), async predict(request) {
      child.stdin.write(JSON.stringify(request) + '\n');
      const result = await next(60_000);
      if (result.error) throw new Error(result.error);
      return result.response;
    } };
  } catch (error) { stop(child); throw error; }
}
async function standardBridge(model, phaseDeadline) {
  // The author's SGLang and adapter must be installed; do not substitute chat generation.
  const transport = await jsonBridge(startLinux([`${linuxEnv('env-native')}/bin/python`, '-u', 'bench/model-comparison/http-worker.py'],
    `${model.id}-http`, { stdio: ['pipe', 'pipe', 'pipe'] }), `${model.id}-http`, phaseDeadline);
  let engine, adapter;
  try {
  for (const port of [30000, 30120]) {
    let occupied = false;
    try { await transport.predict({ port, path: '/health', timeout: 1 }); occupied = true; } catch {}
    if (occupied) throw new Error(`Port ${port} is already occupied; refusing to use another decision server`);
  }
  const script = join(output, `${model.id}-serve.sh`);
  writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\nexport HF_HUB_OFFLINE=1\nexport HF_HOME="$(pwd)/${wslPath(preparation)}/hf-cache"\nexport CUDA_VISIBLE_DEVICES=${decisionGpu.uuid}\nexport CUDA_HOME="${linuxEnv('env-standard')}/lib/python3.12/site-packages/nvidia/cu13"\nexport PATH="${linuxEnv('env-standard')}/bin:$CUDA_HOME/bin:$PATH"\nexport LIBRARY_PATH="$CUDA_HOME/lib:/usr/lib/wsl/lib:\${LIBRARY_PATH:-}"\nexport LD_LIBRARY_PATH="$CUDA_HOME/lib:/usr/lib/wsl/lib:\${LD_LIBRARY_PATH:-}"\nexec ${linuxEnv('env-standard')}/bin/python -m sglang.launch_server --model-path ${wslPath(model.directory)} --served-model-name ${model.id} --host 127.0.0.1 --port 30000 --tp-size 1 --model-impl sglang --dtype bfloat16 --context-length 32768 --max-running-requests 1 --mem-fraction-static 0.8 --chunked-prefill-size -1 --disable-radix-cache --mm-preprocess-cache-size-mb 0 --model-config-parser hf --load-format safetensors\n`);
  const fd = openSync(join(output, `${model.id}.engine.log`), 'a');
  engine = startLinux(['env', ...(standardBackend === 'auto' ? [] : [`SGLANG_FORCE_FUSED_OP_BACKEND=${standardBackend}`]), 'bash', wslPath(script)], `${model.id}-engine`, { stdio: ['ignore', fd, fd] });
  engine.once('close', () => closeSync(fd));
    const until = Math.min(phaseDeadline, Date.now() + 300_000);
    let ready = false;
    while (Date.now() < until && engine.exitCode === null) {
      try { if ((await transport.predict({ port: 30000, path: '/health', timeout: 1 })).status === 200) { ready = true; break; } } catch {}
      await delay(500);
    }
    if (!ready) throw new Error(`Author SGLang unavailable/failed to load; inspect ${model.id}.engine.log`);
    const adapterFd = openSync(join(output, `${model.id}.adapter.log`), 'a');
    adapter = startLinux([`${linuxEnv('env-native')}/bin/python`, '-m', 'jev_adapter',
      '--engine-url', 'http://127.0.0.1:30000', '--model', model.id, '--alias', 'jev-latest', '--host', '127.0.0.1', '--port', '30120',
      '--max-concurrency', '1', '--tokenizer-model', wslPath(model.directory), '--tokenizer-revision', model.revision,
      '--prompt-wording', 'served', '--label-scheme', 'upper', '--default-temperature', '1.65'],
    `${model.id}-adapter`, { stdio: ['ignore', adapterFd, adapterFd] });
    adapter.once('close', () => closeSync(adapterFd));
    ready = false;
    for (let i = 0; i < 100; i++) {
      if (adapter.exitCode !== null) throw new Error('Author adapter failed to start');
      try { if ((await transport.predict({ port: 30120, path: '/health', timeout: 1 })).status === 200) { ready = true; break; } } catch {}
      await delay(200);
    }
    if (!ready) throw new Error('Author adapter did not become healthy');
    return { close() { transport.close(); stop(adapter); stop(engine); }, async predict(request) {
      const response = await transport.predict({ port: 30120, path: '/v1/systemone', body: { model: 'jev-latest', ...request } });
      if (response.status < 200 || response.status >= 300) throw new Error(`Adapter HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      return response.body;
    } };
  } catch (e) { transport.close(); stop(adapter); stop(engine); throw e; }
}
async function screenJudge(model, split = 'diagnostic') {
  const cell = { id: model.id, role: 'judge', split, status: 'running', startedAt: new Date().toISOString(), rows: [] };
  manifest.decisions.push(cell); save(); console.log(`JUDGE ${model.id} ${split}`);
  let bridge;
  try {
    active(split === 'diagnostic' ? screeningDeadline : deadline);
    if (model.kind === 'ollama-nimble') {
      await ollamaStart();
      // Preserve the installed model's own 8194-token context contract.
      const warm = await post('/v1/systemone', { model: 'nimble', ...requestFor(decisionCases[0]) }, 300_000);
      cell.warmup = warm;
      cell.layout = await fetch('http://127.0.0.1:11435/api/ps').then(r => r.json());
      bridge = { close() {}, predict: request => post('/v1/systemone', { model: 'nimble', ...request }) };
    } else {
      if (model.status !== 'downloaded') throw new Error(`Weights unavailable: ${model.reason ?? model.status}`);
      bridge = model.kind === 'standard' ? await standardBridge(model, split === 'diagnostic' ? screeningDeadline : deadline) : await pythonBridge(model, split === 'diagnostic' ? screeningDeadline : deadline);
    }
    cell.hardware = hardware();
    for (const c of decisionCases.filter(c => c.split === split)) {
      active(split === 'diagnostic' ? screeningDeadline : deadline);
      const request = requestFor(c); const at = Date.now();
      try {
        const response = await bridge.predict(request);
        const probability = probabilityOf(response);
        const row = { id: c.id, family: c.family, expected: c.expected, probability, latencyMs: Date.now() - at };
        cell.rows.push(row); trace(`${model.id}-${split}.requests.ndjson`, { request, response, evaluation: row });
      } catch (e) { cell.rows.push({ id: c.id, family: c.family, expected: c.expected, error: String(e), latencyMs: Date.now() - at }); break; }
      save();
    }
    cell.metrics = metrics(cell.rows);
    cell.status = cell.rows.length === 30 && cell.metrics.valid === 30 ? 'completed' : 'incomplete';
    if (cell.status === 'completed' && split === 'diagnostic') {
      cell.orderChecks = [];
      for (const c of decisionCases.filter(c => ['scope-2', 'unknown-1'].includes(c.id))) {
        const row = { id: c.id, expected: c.expected };
        for (const reversed of [false, true]) {
          try {
            active(screeningDeadline);
            const request = choiceRequest(c, reversed), response = await bridge.predict(request);
            row[reversed ? 'reversed' : 'original'] = choiceOf(response);
            trace(`${model.id}-order.requests.ndjson`, { request, response });
          } catch (e) { row.error = String(e); break; }
        }
        row.stable = row.original !== undefined && row.reversed !== undefined ? row.original === row.reversed : null;
        cell.orderChecks.push(row);
      }
    }
  } catch (e) { cell.status = 'unavailable'; cell.error = String(e); }
  finally { bridge?.close(); await ollamaStop(); cell.finishedAt = new Date().toISOString(); save(); console.log(`DONE JUDGE ${model.id} ${cell.status}`); }
  return cell;
}
try {
  for (const variant of judgesOnly ? [] : variants) { if (Date.now() >= screeningDeadline || cancelled) break; await screenExecutor(variant); }
  const availableJudges = [{ id: 'nimble-installed', kind: 'ollama-nimble' }, ...prepared.models.filter(m => ['intern', 'standard', 'nimble'].includes(m.kind))];
  if (judgeIds && [...judgeIds].some(id => !availableJudges.some(m => m.id === id))) throw new Error('Unknown judge id');
  const judges = availableJudges.filter(m => !judgeIds || judgeIds.has(m.id));
  if (holdoutOnly && judges.length !== 1) throw new Error('Holdout-only requires exactly one selected judge');
  if (holdoutOnly) { manifest.selectedJudge = judges[0].id; save(); }
  for (const model of judges) { if (Date.now() >= screeningDeadline || cancelled) break; await screenJudge(model, holdoutOnly ? 'holdout' : 'diagnostic'); }
  const ranked = manifest.candidates.filter(c => c.status === 'screen-passed').sort((a,b) => b.correct - a.correct ||
    (Date.parse(a.finishedAt) - Date.parse(a.startedAt)) - (Date.parse(b.finishedAt) - Date.parse(b.startedAt)));
  manifest.selectedExecutors = ranked.slice(0, 2).map(c => c.id); save();
  for (const selected of ranked.slice(0, 2)) {
    await ollamaStart(selected.cache);
    for (const task of ['add-validator', 'rename-field']) {
      if (Date.now() >= fullDeadline || cancelled) break;
      active(fullDeadline);
      const slug = `model-comparison-${started}-${selected.id}-${task}`;
      const cell = { slug, model: selected.modelId, task, startedAt: new Date().toISOString(), status: 'running' };
      manifest.fullRuns.push(cell); save(); console.log(`FULL ${selected.id} ${task}`);
      const remaining = Math.min(15 * 60_000, fullDeadline - Date.now());
      const code = await command(process.execPath, ['bench/src/cli.ts', '--all', '--model', selected.modelId, '--task', task,
        '--execution-mode', 'guided', '--guided-engine-version', '4', '--preparation-version', '3', '--strict-questions', '--attempts', '3',
        '--stage-timeout', '15', '--run-timeout', '15', '--probe-timeout', '1', '--slug', slug, '--keep-workspace'], remaining,
      { ...process.env, SDLC_CONFIG_DIR: copiedConfig, OLLAMA_BASE_URL: 'http://127.0.0.1:11435/v1', SDLC_RAW_LOG_DIR: join(output, 'raw') }, `${slug}.log`);
      cell.finishedAt = new Date().toISOString();
      const resultPath = join(root, 'bench/results', `${slug}.json`), preflightPath = join(root, 'bench/results', `${slug}.preflight.json`);
      Object.assign(cell, assessGuidedValidation(existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null, cell, code,
        existsSync(preflightPath) ? JSON.parse(readFileSync(preflightPath, 'utf8')) : undefined)); save();
    }
    await ollamaStop();
  }
  const best = manifest.decisions.filter(c => c.status === 'completed' && c.split === 'diagnostic')
    .sort((a,b) => a.metrics.falseAllow - b.metrics.falseAllow || a.metrics.unsupported - b.metrics.unsupported || b.metrics.correct - a.metrics.correct)[0];
  if (best && !diagnosticOnly && Date.now() < deadline && !cancelled) {
    manifest.selectedJudge = best.id; save(); await screenJudge(judges.find(m => m.id === best.id), 'holdout');
  }
  manifest.status = cancelled ? 'interrupted' : budgetExpired || Date.now() >= deadline ? 'budget-exhausted' : 'completed';
} catch (e) { manifest.status = cancelled ? 'interrupted' : budgetExpired ? 'budget-exhausted' : 'stopped'; manifest.error = String(e); }
finally {
  clearTimeout(hardDeadline);
  await ollamaStop(); for (const child of children) stop(child);
  manifest.finishedAt = new Date().toISOString(); manifest.elapsedMinutes = (Date.now() - started) / 60_000;
  manifest.unstartedExecutors = variants.filter(v => !manifest.candidates.some(c => c.id === v.id)).map(v => v.id);
  manifest.unstartedJudges = ['nimble-installed', ...prepared.models.filter(m => ['intern', 'standard', 'nimble'].includes(m.kind)).map(m => m.id)]
    .filter(id => !manifest.decisions.some(c => c.id === id && c.split === 'diagnostic'));
  manifest.unstartedFullRuns = (manifest.selectedExecutors ?? []).flatMap(id => ['add-validator', 'rename-field'].map(task => ({ id, task })))
    .filter(c => !manifest.fullRuns.some(r => r.model === `ollama:comparison-${c.id}` && r.task === c.task));
  save(); renderComparison(output); console.log(`REPORT ${output}`);
}
