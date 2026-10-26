import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMatrix, runMatrix } from './guided-matrix.ts';
import { INPUTS, inventory, stableDigest } from '../bench/src/harnessComparison.ts';
import { atomicJson } from '../server/src/fs/atomicJson.ts';
import { acquireProcessLock, releaseProcessLock } from '../server/src/fs/processLock.ts';
import { assertFollowupConditions, assertEnvironmentConfiguration, type ComparisonManifest } from './stabilitySafety.ts';

type Manifest = ComparisonManifest & { startedAt: string; status: string; error?: string;
  cells: { model: string; task: string; status: string; outcome?: { success: boolean } }[] };
interface Operations {
  prepare: typeof prepareMatrix; run: typeof runMatrix; currentInputs: () => Record<string, string>;
  verifyConfiguration: typeof assertEnvironmentConfiguration;
}
export async function runFollowups(controlDir: string, options: { seriesDir: string; phaseDirs: readonly [string, string]; specFile: string; root?: string; resume?: boolean; operations?: Partial<Operations> }): Promise<void> {
  const root = options.root ?? process.cwd();
  const operations: Operations = { prepare: prepareMatrix, run: runMatrix, currentInputs: () => inventory(root, INPUTS), verifyConfiguration: assertEnvironmentConfiguration, ...options.operations };
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const control = read(join(controlDir, 'manifest.json')) as Manifest;
  if (!control.cells.length || !control.cells.every(c => c.status === 'complete' && c.outcome?.success === true)) throw new Error('All control cells must pass');
  if (stableDigest(operations.currentInputs()) !== stableDigest(control.inputs)) throw new Error('Workspace changed since control');
  const series = resolve(root, options.seriesDir);
  const seriesBack = relative(resolve(root, 'bench/results'), series);
  if (!seriesBack || seriesBack.startsWith('..') || seriesBack.includes(':')) throw new Error('Series outside benchmark workspace');
  const statusFile = join(series, 'status.json');
  if (existsSync(series) && !options.resume) throw new Error('Existing follow-up series requires explicit resume');
  mkdirSync(series, { recursive: true });
  const lock = join(series, 'series.lock'), lease = acquireProcessLock(lock);
  let phases: string[] = options.phaseDirs.map(dir => resolve(root, dir));
  const status = (state: string, extra = {}) => atomicJson(statusFile, { status: state, phases, at: new Date().toISOString(), ...extra });
  const deadline = Date.parse(control.startedAt) + 50 * 3600000;
  try {
    if (options.resume && existsSync(statusFile)) phases = read(statusFile).phases;
    if (!Number.isFinite(deadline) || !Array.isArray(phases) || phases.length !== 2 ||
      new Set(phases.map(dir => resolve(dir).toLowerCase())).size !== 2 || phases.some(dir => resolve(dir).toLowerCase() === resolve(controlDir).toLowerCase())) throw new Error('Invalid series state');
    status('preparing');
    for (let index = 0; index < phases.length; index++) {
      let dir = phases[index]!;
      const back = relative(resolve(root, 'bench/results'), resolve(dir));
      if (!back || back.startsWith('..') || back.includes(':')) throw new Error('Phase outside benchmark workspace');
      if (existsSync(dir) && !existsSync(join(dir, 'manifest.json'))) {
        dir += '-retry-' + randomUUID(); phases[index] = dir; status('preparing');
      }
      if (!existsSync(join(dir, 'manifest.json'))) await operations.prepare(dir, resolve(root, options.specFile), controlDir, controlDir);
      const manifest = read(join(dir, 'manifest.json')) as Manifest;
      assertFollowupConditions(control, manifest);
      operations.verifyConfiguration(controlDir, dir, manifest.profiles);
    }
    for (const dir of phases) {
      if (existsSync(join(series, 'stop-requested')) || Date.now() >= deadline) throw new Error('Series stopped or budget exhausted');
      if ((read(join(dir, 'manifest.json')) as Manifest).status === 'complete') continue;
      status('running', { active: dir });
      const aborter = new AbortController();
      const timer = setInterval(() => { if (existsSync(join(series, 'stop-requested')) || Date.now() >= deadline) aborter.abort(); }, 1000);
      try { await operations.run(dir, { signal: aborter.signal }); } finally { clearInterval(timer); }
      const manifest = read(join(dir, 'manifest.json')) as Manifest;
      if (manifest.status !== 'complete') throw new Error(manifest.error ?? manifest.status);
      if (dir === phases[0]) {
        const next = read(join(phases[1]!, 'manifest.json')) as Manifest;
        if (!manifest.modelDigests) throw new Error('Completed matrix has no model pins');
        next.modelDigests = manifest.modelDigests; next.engineVersion = manifest.engineVersion;
        atomicJson(join(phases[1]!, 'manifest.json'), next);
      }
    }
    const [first, second] = phases.map(dir => read(join(dir, 'manifest.json')) as Manifest);
    const pairs = first!.cells.map(cell => ({ model: cell.model, task: cell.task, first: cell.outcome,
      second: second!.cells.find(other => other.model === cell.model && other.task === cell.task)?.outcome ?? null }));
    atomicJson(join(series, 'comparison.json'), { pairs, reproducedSuccesses: pairs.filter(pair => pair.first?.success && pair.second?.success).length });
    status('complete');
  } catch (error) { status('stopped', { error: String(error) }); throw error; }
  finally { releaseProcessLock(lock, lease); }
}
