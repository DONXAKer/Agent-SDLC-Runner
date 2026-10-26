import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { INPUTS, assertEngineLog, assertExactPair, assertFrozen, assertPair, baselineText, comparisonSpec,
  coordinatorHash, inventory, lessonStatus, readJson, recoverInterrupted, remainingRunMs, report, saveJson, schedule, stableDigest,
  comparisonRawLogDir, collectComparisonEvidence } from '../bench/src/harnessComparison.ts';
import type { Cell, Manifest } from '../bench/src/harnessComparison.ts';
import { assessGuidedValidation, currentGuidedResult } from '../bench/src/guidedValidation.ts';
import type { BenchResult } from '../bench/src/result.ts';
import type { PreflightReport } from '../bench/src/preflight.ts';

const root = resolve(import.meta.dirname, '..');
function flag(args: string[], key: string): string | undefined {
  const index = args.indexOf(key); if (index < 0) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith('--')) throw Error(`Missing ${key}`); return value;
}
function inside(base: string, path: string): string {
  const target = resolve(base, path), rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(base) === target || rel.includes(':')) throw Error(`Path outside experiment: ${path}`);
  return target;
}
function emit(dir: string, m: Manifest): void {
  saveJson(join(dir, 'manifest.json'), m); writeFileSync(join(dir, 'report.ru.md'), report(m));
  saveJson(join(dir, 'lesson.json'), { version: 1, status: lessonStatus(m), cue: m.spec.cue, lesson: m.spec.lesson,
    evidence: m.cells.map(c => ({ arm: c.arm, task: c.task, run: `runs/${c.id}`, success: c.outcome?.success ?? null,
      sourceHash: stableDigest(m.inputs[c.arm]) })),
    limitations: ['Pilot only; no statistical claim', 'No automatic prompt injection', 'Task answers and grader verdicts must not be inserted in runtime prompts'],
    confidence: 'limited', automaticallyApplied: false });
}
export async function prepare(dir: string, specFile: string, baseline?: string, candidate?: string): Promise<void> {
  if (existsSync(dir)) throw Error('Use a fresh output directory');
  if ((baseline === undefined) !== (candidate === undefined)) throw Error('Supply both --baseline and --candidate');
  const spec = comparisonSpec.parse(readJson(specFile));
  const { loadConfig } = await import('../server/src/config/load.ts');
  const config = loadConfig();
  const modelConfig = readJson<{ models: Manifest['modelProfile'][]; providers: Record<string, { baseUrl?: string }> }>(resolve(root, spec.modelConfig));
  const profile = modelConfig.models.find(p => p.id === spec.model);
  if (!profile || profile.provider !== 'ollama') throw Error('This experiment requires an explicit Ollama model profile');
  mkdirSync(dir, { recursive: true });
  const common = join(dir, 'common'); mkdirSync(common);
  for (const [name, source] of [['methodology', config.runner.methodologyDir], ['skills', config.runner.skillsDir], ['agents', config.runner.agentsDir]] as const) {
    inventory(source, readdirSync(source).filter(n => n !== '.git'));
    cpSync(source, join(common, name), { recursive: true, filter: src => relative(source, src).split(sep)[0] !== '.git' });
  }
  cpSync(config.dir, join(common, 'config'), { recursive: true });
  const models = readJson<{ models: Manifest['modelProfile'][]; providers: Record<string, { baseUrl?: string }> }>(join(common, 'config/models.json'));
  models.models = [...models.models.filter(p => p.id !== profile.id), profile];
  if (!models.providers[profile.provider]) throw Error('Missing provider configuration');
  models.providers[profile.provider]!.baseUrl = spec.engine.host + '/v1'; saveJson(join(common, 'config/models.json'), models);
  saveJson(join(common, 'config/runner.local.json'), { ...config.runner,
    methodologyDir: join(common, 'methodology'), skillsDir: join(common, 'skills'), agentsDir: join(common, 'agents'), reviewModel: profile.id });
  // Freeze third-party dependencies once. Workspace imports must resolve to the copied sources.
  cpSync(join(root, 'node_modules'), join(common, 'node_modules'), { recursive: true,
    filter: src => !['@sdlc-runner', '.cache', '.bin'].includes(relative(join(root, 'node_modules'), src).split(sep)[0] ?? '') });
  for (const arm of ['A', 'B'] as const) {
    const destination = join(dir, 'snapshots', arm); mkdirSync(destination, { recursive: true });
    const source = arm === 'A' ? baseline ?? candidate ?? root : candidate ?? root;
    for (const input of INPUTS) {
      inventory(source, [input]); mkdirSync(dirname(join(destination, input)), { recursive: true });
      cpSync(join(source, input), join(destination, input), { recursive: true });
    }
    if (arm === 'A' && baseline === undefined) {
      const file = inside(destination, spec.change.path);
      writeFileSync(file, baselineText(readFileSync(file, 'utf8'), spec.change));
    }
    mkdirSync(join(destination, 'node_modules'));
    for (const name of readdirSync(join(common, 'node_modules')))
      symlinkSync(join(common, 'node_modules', name), join(destination, 'node_modules', name), 'junction');
    mkdirSync(join(destination, 'node_modules/@sdlc-runner'));
    symlinkSync(join(destination, 'shared'), join(destination, 'node_modules/@sdlc-runner/shared'), 'junction');
  }
  const inputs = { A: inventory(join(dir, 'snapshots/A'), INPUTS), B: inventory(join(dir, 'snapshots/B'), INPUTS), common: inventory(common) };
  assertPair(inputs.A, inputs.B, spec.change); assertExactPair(join(dir, 'snapshots/A'), join(dir, 'snapshots/B'), spec.change);
  const delta = spawnSync('git', ['diff', '--no-index', '--', join(dir, 'snapshots/A', spec.change.path), join(dir, 'snapshots/B', spec.change.path)],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (delta.status !== 1) throw Error(`Cannot produce declared diff: ${delta.stderr}`);
  writeFileSync(join(dir, 'change.diff'), delta.stdout);
  const m: Manifest = { version: 1, spec, specHash: stableDigest(spec), preparedAt: new Date().toISOString(), status: 'prepared', inputs,
    nodeVersion: process.version, coordinatorHash: coordinatorHash(), modelProfile: profile, cells: schedule(spec.tasks) };
  emit(dir, m);
}

function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
function killTree(pid: number): void {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(pid, 'SIGTERM');
}
interface EngineModel { name: string; digest: string; size: number; size_vram: number; context_length?: number }
async function jsonRequest(host: string, path: string, body?: unknown, timeout = 10000): Promise<unknown> {
  const response = await fetch(host + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error(`${path}: ${response.status} ${await response.text()}`); return response.json();
}
function assess(dir: string, m: Manifest, c: Cell, code: number | null, error?: string): void {
  const call = c.invocations.at(-1)!; call.finishedAt = new Date().toISOString();
  const snapshot = join(dir, 'snapshots', c.arm), runDir = join(dir, 'runs', c.id, call.slug);
  const resultFile = join(snapshot, 'bench/results', call.slug + '.json');
  const preflightFile = join(snapshot, 'bench/results', call.slug + '.preflight.json');
  const value = existsSync(resultFile) ? readJson<BenchResult>(resultFile) : null;
  const preflight = existsSync(preflightFile) ? readJson<PreflightReport & { slug: string; startedAt: string; finishedAt: string }>(preflightFile) : undefined;
  const expected = { ...call, finishedAt: call.finishedAt, task: c.task, model: m.spec.model };
  c.outcome = assessGuidedValidation(value, expected, code, preflight);
  c.evidence = collectComparisonEvidence(currentGuidedResult(value, expected) ? value : null, snapshot, call);
  c.elapsedMs = Date.parse(call.finishedAt) - Date.parse(call.startedAt); c.status = 'complete'; if (error) c.error = error;
  mkdirSync(runDir, { recursive: true });
  for (const [source, target] of [[resultFile, 'result.json'], [preflightFile, 'preflight.json'],
    [join(snapshot, 'bench/traces', call.slug), 'traces'], [c.evidence.traceCollection!.directory, 'raw']] as const)
    if (existsSync(source)) cpSync(source, join(runDir, target), { recursive: true });
  saveJson(join(runDir, 'assessment.json'), c); emit(dir, m);
}
export async function run(dir: string, resume: boolean): Promise<void> {
  const m = readJson<Manifest>(join(dir, 'manifest.json')); comparisonSpec.parse(m.spec); assertFrozen(dir, m);
  const lock = join(dir, 'run.lock');
  if (existsSync(lock)) {
    const previous = readJson<{ pid: number }>(lock);
    if (isAlive(previous.pid)) throw Error(`Experiment is already running: ${previous.pid}`);
    if (!resume) throw Error('Stale lock: inspect and use resume');
    rmSync(lock);
  }
  recoverInterrupted(m.cells, resume, isAlive);
  const fd = openSync(lock, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd);
  let cancelled = false;
  const children = new Set<ReturnType<typeof spawn>>();
  const cancel = (): void => { cancelled = true; for (const child of children) if (child.pid && child.exitCode === null) try { killTree(child.pid); } catch {} };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const start = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logfile: string): ReturnType<typeof spawn> => {
    const fd = openSync(logfile, 'a'); const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd); children.add(child); child.once('close', () => children.delete(child)); return child;
  };
  try {
    if (m.cells.every(c => c.status === 'complete')) { m.status = 'complete'; emit(dir, m); return; }
    m.status = 'waiting-gpu'; emit(dir, m);
    while (!cancelled) {
      const gpu = execFileSync('nvidia-smi', ['--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true })
        .trim().split(/\r?\n/u).map(line => line.split(',').map(Number));
      if (gpu.length === m.spec.engine.gpuFreeMiB.length && gpu.every((g, i) => g[0]! >= m.spec.engine.gpuFreeMiB[i]! && g[1]! <= m.spec.engine.gpuUtilMax[i]!)) break;
      console.log('Waiting for free GPU', JSON.stringify(gpu)); await delay(15000);
    }
    if (cancelled) return;
    const host = m.spec.engine.host, url = new URL(host);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw Error('Dedicated local HTTP engine required');
    try { await fetch(host + '/api/version', { signal: AbortSignal.timeout(1000) }); throw Error('Dedicated engine port already occupied'); }
    catch (e) { if (e instanceof Error && e.message === 'Dedicated engine port already occupied') throw e; }
    const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: url.host, OLLAMA_KV_CACHE_TYPE: m.spec.engine.cache,
      OLLAMA_FLASH_ATTENTION: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_VULKAN: 'false', OLLAMA_SCHED_SPREAD: 'true', OLLAMA_LLM_LIBRARY: 'cuda_v12', OLLAMA_NO_CLOUD: 'true' };
    delete env.CUDA_VISIBLE_DEVICES;
    if (!env.OLLAMA_MODELS && process.platform === 'win32') env.OLLAMA_MODELS = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')"], { encoding: 'utf8', windowsHide: true }).trim();
    const engineLog = join(dir, 'engine.log');
    const engine = start('ollama', ['serve'], root, env, engineLog);
    engine.once('error', e => { console.error(e); cancel(); });
    let ready = false;
    for (let i = 0; i < 100 && !cancelled; i++) {
      if (engine.exitCode !== null) throw Error('Engine exited before readiness');
      try { await jsonRequest(host, '/api/version'); ready = true; break; } catch { await delay(200); }
    }
    if (!ready) throw Error('Engine not ready');
    const show = await jsonRequest(host, '/api/show', { model: m.modelProfile.model });
    const version = await jsonRequest(host, '/api/version');
    m.status = 'running'; emit(dir, m);
    for (const cell of m.cells.filter(c => c.status === 'pending')) {
      if (cancelled) break;
      assertFrozen(dir, m);
      const availableMs = remainingRunMs(cell, m.spec.limits.runMinutes * 60000);
      if (availableMs <= 0) {
        cell.status = 'complete'; cell.outcome = { status: 'no-current-result', success: false, reason: 'Invocation budget exhausted after interruption', exitCode: null, diagnosis: 'unassessed',
          outcomeKind: 'incomplete', evidenceLevel: 'none', modelQualitySuccess: false, modelTaskEvaluated: false, operationalSuccess: false, environmentFailure: false };
        emit(dir, m); continue;
      }
      // Clear KV/runtime state between arms and verify the effective layout for every invocation.
      await jsonRequest(host, '/api/generate', { model: m.modelProfile.model, keep_alive: 0 }, 30000);
      const logOffset = readFileSync(engineLog, 'utf8').length;
      await jsonRequest(host, '/api/generate', { model: m.modelProfile.model, prompt: 'Reply OK.', stream: false, think: false,
        options: { num_ctx: m.spec.engine.context, num_predict: 1 } }, 300000);
      const layout = await jsonRequest(host, '/api/ps') as { models: EngineModel[] };
      const loaded = layout.models.find(p => p.name === m.modelProfile.model || p.name === m.modelProfile.model + ':latest');
      if (!loaded || loaded.size_vram / loaded.size < 0.99 || loaded.context_length !== m.spec.engine.context) throw Error('Model is not fully on GPU with the declared context');
      const log = readFileSync(engineLog, 'utf8').slice(logOffset);
      assertEngineLog(log, m.spec.engine.gpuFreeMiB.length);
      const identity = { version, digest: loaded.digest, show };
      if (m.engineIdentity && stableDigest(m.engineIdentity) !== stableDigest(identity)) throw Error('Engine/model identity changed');
      m.engineIdentity = identity;
      const slug = 'harness-' + randomUUID(), startedAt = new Date().toISOString();
      const snapshot = join(dir, 'snapshots', cell.arm), runDir = join(dir, 'runs', cell.id, slug); mkdirSync(runDir, { recursive: true });
      const rawLogDir = comparisonRawLogDir(snapshot);
      cell.invocations.push({ slug, startedAt, rawLogDir }); cell.status = 'running';
      saveJson(join(runDir, 'layout.json'), layout); emit(dir, m);
      const common = join(dir, 'common');
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SDLC_')));
      const runEnv = { ...cleanEnv, SDLC_CONFIG_DIR: join(common, 'config'), SDLC_STATE_DIR: join(dir, 'state', slug),
        SDLC_METHODOLOGY_DIR: join(common, 'methodology'), SDLC_SKILLS_DIR: join(common, 'skills'), SDLC_AGENTS_DIR: join(common, 'agents'),
        SDLC_CONSTANTS_PATH: join(common, 'methodology/sdlc-constants.json'), OLLAMA_BASE_URL: host + '/v1', SDLC_RAW_LOG_DIR: rawLogDir };
      const child = start(process.execPath, ['bench/src/cli.ts', '--all', '--model', m.spec.model, '--task', cell.task,
        '--execution-mode', 'guided', '--guided-engine-version', '4', '--preparation-version', '3', '--strict-questions',
        '--attempts', String(m.spec.limits.attempts), '--stage-timeout', String(m.spec.limits.stageMinutes), '--run-timeout', String(availableMs / 60000),
        '--probe-timeout', '1', '--slug', slug, '--keep-workspace'], snapshot, runEnv, join(runDir, 'launcher.log'));
      if (child.pid !== undefined) cell.invocations.at(-1)!.pid = child.pid;
      emit(dir, m); console.log(`Starting ${cell.id} ${cell.task}: ${slug}`);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; if (child.pid && child.exitCode === null) try { killTree(child.pid); } catch {} }, availableMs);
      let code: number | null = null, launchError: string | undefined;
      try { code = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); }); }
      catch (e) { launchError = String(e); } finally { clearTimeout(timer); }
      assess(dir, m, cell, code, timedOut ? 'Wall-clock run timeout' : launchError);
      assertFrozen(dir, m);
      if (cancelled) { cell.status = 'interrupted'; emit(dir, m); break; }
    }
    if (!cancelled) m.status = 'complete';
  } catch (e) { m.error = String(e); m.status = 'environment-failure'; console.error(e); process.exitCode = 1; }
  finally {
    if (cancelled) m.status = 'interrupted';
    for (const child of children) if (child.pid && child.exitCode === null) try { killTree(child.pid); } catch {}
    emit(dir, m); rmSync(lock, { force: true }); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
/** Reconstruct measurements without changing the frozen experiment or its outcomes. */
export function recoverEvidenceReport(dir: string): void {
  const m = readJson<Manifest>(join(dir, 'manifest.json'));
  if (existsSync(join(dir, 'run.lock'))) throw Error('Cannot recover evidence while a run lock exists');
  if (m.status !== 'complete') throw Error('Evidence recovery requires a completed experiment');
  const sourceManifestHash = stableDigest(m);
  for (const c of m.cells) {
    const call = c.invocations.at(-1);
    if (!call?.finishedAt || call.abandoned || c.status !== 'complete') continue;
    const snapshot = join(dir, 'snapshots', c.arm);
    const result = readJson<BenchResult>(join(snapshot, 'bench/results', call.slug + '.json'));
    const expected = { ...call, finishedAt: call.finishedAt, task: c.task, model: m.spec.model };
    if (!currentGuidedResult(result, expected)) throw Error(`Stale result: ${c.id}`);
    c.evidence = collectComparisonEvidence(result, snapshot, call);
  }
  saveJson(join(dir, 'evidence-recovered.json'), { recoveredAt: new Date().toISOString(), sourceManifestHash,
    collectorHash: coordinatorHash(), cells: m.cells.map(c => ({ id: c.id, evidence: c.evidence })) });
  writeFileSync(join(dir, 'report.recovered.ru.md'), report(m));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2), output = flag(args, '--output');
  if (!output || !['prepare', 'run', 'resume', 'report', 'recover-evidence'].includes(command ?? '')) throw Error('Usage: node tools/harness-comparison.ts prepare|run|resume|report|recover-evidence --output DIR [--spec FILE] [--baseline ROOT --candidate ROOT]');
  const dir = inside(root, output);
  if (command === 'prepare') {
    const spec = flag(args, '--spec'); if (!spec) throw Error('--spec required');
    await prepare(dir, resolve(root, spec), flag(args, '--baseline'), flag(args, '--candidate'));
  } else if (command === 'recover-evidence') recoverEvidenceReport(dir);
  else if (command === 'report') emit(dir, readJson<Manifest>(join(dir, 'manifest.json')));
  else await run(dir, command === 'resume');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(e => { console.error(e); process.exitCode = 1; });
