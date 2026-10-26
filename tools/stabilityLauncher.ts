import { existsSync, openSync, closeSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareMatrix, runMatrix } from './guided-matrix.ts';
import { atomicJson } from '../server/src/fs/atomicJson.ts';
import { acquireProcessLock, adoptProcessLock, releaseProcessLock, assertProcessesExited } from '../server/src/fs/processLock.ts';
import { INPUTS, inventory, stableDigest } from '../bench/src/harnessComparison.ts';
import { simulationSourceHash } from '../bench/src/simulator/sourceHash.ts';
import { guidedScenarioIds } from '../bench/src/simulator/guidedV4.ts';
import { assertSimulatorReport } from './stabilitySafety.ts';
import { runFollowups } from './stabilitySeries.ts';

export async function launchStabilityControl(args: string[]): Promise<void> {
  const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const required = (key: string) => { const found = value(key); if (!found) throw new Error(`Required argument: ${key}`); return found; };
  const output = resolve(required('--output'));
  const back = relative(resolve('bench/results'), output);
  if (!back || back.startsWith('..') || back.includes(':')) throw new Error('Control output must be inside bench/results');
  const simulator = resolve(required('--simulator'));
  const specFile = resolve(required('--spec'));
  const statusPath = output + '.launcher-status.json', lock = output + '.launcher.lock';
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const requestedSpec = read(specFile);
  const engineVersion = requestedSpec.guidedEngineVersion;
  if (engineVersion !== 4 && engineVersion !== 5) throw new Error('Unsupported guided protocol');
  mkdirSync(dirname(output), { recursive: true });
  if (args[0] !== 'worker') {
    if (existsSync(output) && !args.includes('--resume')) throw new Error('Existing output requires explicit resume');
    const lease = acquireProcessLock(lock); // Acquired before any wait or spawn.
    let fd: number | undefined;
    try {
      fd = openSync(output + '.launcher.log', 'a');
      const child = spawn(process.execPath, [import.meta.filename, 'worker', '--lease', lease, ...args],
      { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      closeSync(fd); fd = undefined;
      await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
      child.unref();
      console.log(JSON.stringify({ pid: child.pid, output, status: statusPath }));
    } catch (error) { releaseProcessLock(lock, lease); throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    return;
  }
  const lease = value('--lease');
  if (!lease) throw new Error('Worker requires a process lease');
  adoptProcessLock(lock, lease);
  const aborter = new AbortController(), cancel = () => aborter.abort(new Error('Control cancelled'));
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const status = (state: string, extra = {}) => atomicJson(statusPath, { status: state, pid: process.pid, output, at: new Date().toISOString(), ...extra });
  try {
    status('waiting-simulator');
    const deadline = Date.now() + 10 * 60000;
    while (!existsSync(simulator)) {
      if (Date.now() > deadline) throw new Error('Simulator gate deadline exceeded');
      await delay(2000, undefined, { signal: aborter.signal });
    }
    const report = read(simulator);
    const verifyReport = () => assertSimulatorReport(report, simulationSourceHash(process.cwd()), guidedScenarioIds(engineVersion));
    verifyReport();
    status('preparing');
    if (existsSync(output)) {
      if (!args.includes('--resume')) throw new Error('Control output already exists');
      const manifest = read(join(output, 'manifest.json')), runLock = join(output, 'run.lock');
      assertProcessesExited([...(existsSync(runLock) ? [read(runLock).pid] : []), ...manifest.cells.filter((c: { status: string }) => c.status === 'running').map((c: { pid: number }) => c.pid)]);
      if (existsSync(runLock)) unlinkSync(runLock);
      if (manifest.cells.some((c: { status: string }) => c.status === 'running')) throw new Error('Interrupted cell requires explicit result assessment');
    } else {
      await prepareMatrix(output, specFile, value('--reuse-dependencies'));
    }
    verifyReport();
    const prepared = read(join(output, 'manifest.json'));
    if (stableDigest(prepared.spec) !== stableDigest(requestedSpec)) throw new Error('Experiment changed during preparation');
    if (stableDigest(prepared.inputs) !== stableDigest(inventory(process.cwd(), INPUTS))) throw new Error('Prepared snapshot differs from simulator-verified sources');
    prepared.simulatorEvidence = { sourceHash: report.sourceHash, report: simulator };
    atomicJson(join(output, 'manifest.json'), prepared);
    status('running');
    await runMatrix(output, { stopOnFailure: true, signal: aborter.signal });
    const manifest = read(join(output, 'manifest.json'));
    const failed = manifest.cells.find((c: { status: string; outcome?: { success: boolean } }) => c.status === 'complete' && c.outcome?.success !== true);
    const passed = manifest.status === 'complete' && manifest.cells.length > 0 && manifest.cells.every((c: { status: string; outcome?: { success: boolean } }) => c.status === 'complete' && c.outcome?.success === true);
    atomicJson(join(output, 'stability-gate.json'), { passed, firstFailure: failed?.id ?? null, at: new Date().toISOString() });
    status(failed ? 'failed-control' : manifest.status);
    if (value('--followup-spec') && passed) await runFollowups(output, { resume: args.includes('--resume'),
      seriesDir: required('--series'), phaseDirs: [required('--phase-one'), required('--phase-two')], specFile: required('--followup-spec') });
  } catch (error) { status('failed', { error: String(error) }); throw error; }
  finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); releaseProcessLock(lock, lease); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  launchStabilityControl(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
