import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WitokPaths } from '../../server/src/artifacts/paths.ts';
import { stageById } from '../../server/src/run/stages.ts';
import { snapshotRuntimeVerdict, startStageAfter } from './snapshot.ts';
import { taskById, taskPaths } from './tasks.ts';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { sha256Text } from '../../server/src/run/evidence.ts';

export interface DiagnosticCase {
  id: string; task: string; stage: string; snapshotAfter: string | null;
  snapshot?: string; seed?: string; evaluation: string; problemIds?: number[];
  expectedBlocked?: boolean;
}

export interface DiagnosticInput {
  status: 'available' | 'missing-input' | 'missing-snapshot' | 'invalid-snapshot';
  reason: string;
  snapshot: string | null;
}

export function diagnosticCliArgs(args: {
  model: string; testCase: DiagnosticCase; slug: string; timeoutMinutes: number;
  local: boolean; snapshot: string | null;
}): string[] {
  const { model, testCase, slug, timeoutMinutes } = args;
  const out = ['--model', model, '--task', testCase.task, '--stage', testCase.stage, '--slug', slug,
    '--stop-after-stage', testCase.stage, '--stage-timeout', String(timeoutMinutes),
    '--run-timeout', String(timeoutMinutes), '--no-preflight', '--quiet'];
  out.push('--capture-inputs');
  if (args.local) for (const stage of STAGE_ORDER) out.push(`--control-${stage}`, model);
  if (args.snapshot) out.push('--from-snapshot', args.snapshot);
  if (testCase.seed) out.push('--seed', testCase.seed);
  return out;
}

/** Inventory and live diagnosis share the actual stage preconditions, not just snapshot metadata. */
export function checkDiagnosticInput(bench: string, testCase: DiagnosticCase): DiagnosticInput {
  const paths = taskPaths(bench, taskById(testCase.task));
  const missing = [paths.taskFile, paths.humanFile, paths.expectedFile, paths.hiddenFile].filter((path) => !existsSync(path));
  if (missing.length) return { status: 'missing-input', reason: missing.join(', '), snapshot: null };
  if (testCase.snapshotAfter === null) return { status: 'available', reason: 'fixture input', snapshot: null };
  const snapshots = join(bench, 'snapshots');
  const names = existsSync(snapshots) ? readdirSync(snapshots, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const candidates = testCase.snapshot ? [testCase.snapshot] : names.filter((name) => {
    try {
      const meta = JSON.parse(readFileSync(join(snapshots, name, 'snapshot.json'), 'utf8'));
      return meta.task === testCase.task && meta.stoppedAfterStage === testCase.snapshotAfter;
    } catch { return false; }
  });
  if (!candidates.length) return { status: 'missing-snapshot', reason: `no validated ${testCase.task} snapshot after ${testCase.snapshotAfter}`, snapshot: null };
  let lastProblem: DiagnosticInput = { status: 'missing-snapshot', reason: 'snapshot not found', snapshot: null };
  for (const name of candidates) {
    try {
      const root = join(snapshots, name);
      const meta = JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8'));
      if (meta.task !== testCase.task || meta.stoppedAfterStage !== testCase.snapshotAfter || startStageAfter(meta.stoppedAfterStage) !== testCase.stage) {
        lastProblem = { status: 'invalid-snapshot', reason: `${name} does not start ${testCase.stage} for ${testCase.task}`, snapshot: null };
        continue;
      }
      if (typeof meta.slug !== 'string' || !meta.slug) throw new Error('snapshot slug missing');
      if (testCase.expectedBlocked && meta.inputPreparation?.kind !== 'missing-runtime-verdict') continue;
      if (testCase.seed && testCase.seed !== 'none' && testCase.stage !== 'verify') throw new Error('seed is only valid for verify');
      const context = { paths: new WitokPaths(root, meta.slug), chunk: 1, attempt: 1 };
      if (testCase.stage === 'handoff') {
        if (testCase.expectedBlocked && !snapshotRuntimeVerdict(root, meta)
          && existsSync(context.paths.verificationReport(1, 1))
          && stageById('handoff').requires.some((requirement) => requirement.check(context) !== null)) {
          return { status: 'available', reason: `${name}: expected missing runtime verdict`, snapshot: name };
        }
        if (meta.verdictSource?.chunk === 1 && meta.verdictSource?.attempt === 1 && snapshotRuntimeVerdict(root, meta)) {
          return { status: 'available', reason: name, snapshot: name };
        }
        lastProblem = { status: 'invalid-snapshot', reason: `${name}: no matching passed runtime verdict for attempt 1`, snapshot: null };
        continue;
      }
      const blockers = stageById(testCase.stage as Parameters<typeof stageById>[0]).requires
        .map((requirement) => requirement.check(context)).filter((reason) => reason !== null);
      if (blockers.length) {
        lastProblem = { status: 'invalid-snapshot', reason: `${name}: ${blockers.join('; ')}`, snapshot: null };
        continue;
      }
      if (testCase.stage === 'verify') {
        const evidence = JSON.parse(readFileSync(context.paths.chunkEvidence(1, 1), 'utf8'));
        for (const [path, hash] of [[context.paths.chunkDiff(1, 1), evidence.diff_sha256],
          [context.paths.chunkTests(1, 1), evidence.tests_sha256]]) {
          if (sha256Text(readFileSync(path, 'utf8')) !== hash) throw new Error(`stale attempt evidence: ${path}`);
        }
      }
      return { status: 'available', reason: name, snapshot: name };
    } catch (error) {
      lastProblem = { status: existsSync(join(snapshots, name)) ? 'invalid-snapshot' : 'missing-snapshot',
        reason: `${name}: ${String(error)}`, snapshot: null };
    }
  }
  return lastProblem;
}
