import { test } from 'node:test';
import { throws, equal } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertFollowupConditions, assertSimulatorReport, assertEnvironmentConfiguration, type ComparisonManifest } from '../../tools/stabilitySafety.ts';
import { runFollowups } from '../../tools/stabilitySeries.ts';
import { simulationSourceHash } from '../src/simulator/sourceHash.ts';

const control = (): ComparisonManifest => ({ inputs: {}, common: { 'methodology/rules.md': 'A', 'node_modules/package.json': 'dependencies' },
  profiles: [{ id: 'model-a' }], acceptanceImage: 'image@sha256:one', nodeVersion: process.version, coordinatorHash: 'coordinator',
  modelDigests: { 'model-a': 'weights-a' }, engineVersion: { version: 'engine-a' }, spec: { engine: { host: 'http://localhost:1' },
    guidedEngineVersion: 5, limits: { stageMinutes: 15, runMinutes: 30, attempts: 3 } } });

test('followups reject changed engine, model, common environment and image', () => {
  const reference = control();
  assertFollowupConditions(reference, structuredClone(reference));
  for (const next of [{ ...reference, engineVersion: { version: 'different' } }, { ...reference, modelDigests: {} },
    { ...reference, modelDigests: { 'model-a': 'weights-b' } }, { ...reference, acceptanceImage: 'different-image' },
    { ...reference, common: { 'methodology/rules.md': 'B' } }, { ...reference, coordinatorHash: 'changed' },
    { ...reference, spec: { ...reference.spec, guidedEngineVersion: 4 } },
    { ...reference, spec: { ...reference.spec, limits: { stageMinutes: 30, runMinutes: 30, attempts: 3 } } }])
    throws(() => assertFollowupConditions(reference, next));
});

test('simulator gate rejects stale sources and false scenario coverage', () => {
  const report = { kind: 'deterministic-runtime-simulation', passed: true, node: process.version, sourceHash: 'verified', cases: [{ id: 'one', passed: true, errors: [], checks: ['check'] }] };
  assertSimulatorReport(report, 'verified', ['one']);
  throws(() => assertSimulatorReport(report, 'edited', ['one']), /sources/);
  throws(() => assertSimulatorReport({ ...report, node: 'old-node' }, 'verified', ['one']), /sources/);
  throws(() => assertSimulatorReport(report, 'verified', ['another']), /coverage/);
  throws(() => assertSimulatorReport({ ...report, cases: [{ ...report.cases[0]!, passed: false }] }, 'verified', ['one']), /coverage/);
});

test('shared simulator fingerprint changes on source edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'simulator-source-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['server/src', 'server/methodology', 'shared/src', 'bench/src', 'server/test/fixtures/guided-v4', 'bench/fixtures/guided-process']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}');
  const before = simulationSourceHash(root);
  writeFileSync(join(root, 'server/src/new.ts'), 'export const changed = true;');
  equal(before === simulationSourceHash(root), false);
});

test('configuration comparison permits only relocated paths and declared model profiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'environment-identity-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first'), next = join(root, 'next');
  for (const dir of [first, next]) mkdirSync(join(dir, 'common/config'), { recursive: true });
  const write = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, 'common/config', name), JSON.stringify(value));
  write(first, 'runner.local.json', { methodologyDir: 'old/path', policy: 'strict' });
  write(next, 'runner.local.json', { methodologyDir: 'new/path', policy: 'strict' });
  write(first, 'models.json', { providers: { local: 'same' }, models: [{ id: 'model-a' }, { id: 'model-b' }] });
  write(next, 'models.json', { providers: { local: 'same' }, models: [{ id: 'model-a' }, { id: 'model-b' }] });
  assertEnvironmentConfiguration(first, next, [{ id: 'model-a' }, { id: 'model-b' }]);
  write(next, 'runner.local.json', { methodologyDir: 'new/path', policy: 'relaxed' });
  throws(() => assertEnvironmentConfiguration(first, next, [{ id: 'model-a' }]), /configuration/);
});

test('failed preparation is stopped, releases its lease, and resumes without deleting partial artifacts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stability-series-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const controlDir = join(root, 'bench/results/control'); mkdirSync(controlDir, { recursive: true });
  const manifest = { ...control(), status: 'complete', startedAt: new Date().toISOString(), cells: [{ model: 'model-a', task: 'task', status: 'complete', outcome: { success: true } }] };
  const write = (dir: string, value: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'manifest.json'), JSON.stringify(value)); };
  write(controlDir, manifest);
  let partial = '', failed = false;
  const prepare = async (dir: string, _spec: string, dependencies?: string, environment?: string) => {
    equal(dependencies, controlDir); equal(environment, controlDir);
    if (!failed) { failed = true; partial = dir; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'partial'), 'retained'); throw new Error('OUT_OF_SPACE'); }
    write(dir, { ...manifest, status: 'prepared' });
  };
  let runs = 0;
  const run = async (dir: string) => {
    const next = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assertFollowupConditions(manifest, next); runs++;
    write(dir, { ...next, status: 'complete' });
  };
  const options = { root, seriesDir: 'bench/results/series', phaseDirs: ['bench/results/cycle-one', 'bench/results/cycle-two'] as const,
    specFile: 'experiment.json', operations: { prepare, run, currentInputs: () => ({}), verifyConfiguration: () => {} } };
  const { rejects } = await import('node:assert/strict');
  await rejects(runFollowups(controlDir, options), /OUT_OF_SPACE/);
  const series = join(root, options.seriesDir);
  equal(JSON.parse(readFileSync(join(series, 'status.json'), 'utf8')).status, 'stopped');
  equal(existsSync(join(series, 'series.lock')), false);
  await runFollowups(controlDir, { ...options, resume: true });
  equal(existsSync(join(partial, 'partial')), true);
  equal(JSON.parse(readFileSync(join(series, 'status.json'), 'utf8')).status, 'complete');
  equal(runs, 2);
});
