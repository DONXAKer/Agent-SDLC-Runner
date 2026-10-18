/** Refresh stale reference evidence by executing the runtime's actual test/evidence recorder. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { recordAttemptEvidence } from '../server/src/run/evidence.ts';
import { loadGates, runGateByName } from '../server/src/gates/run.ts';
import { treeDigest } from './src/diagnostics.ts';
import { restoreSnapshot } from './src/snapshot.ts';

const snapshots = resolve(fileURLToPath(new URL('snapshots', import.meta.url)));
const source = join(snapshots, 'oversize-axes3-diagnostic-v2');
const target = join(snapshots, 'oversize-axes3-diagnostic-v4');
const meta = JSON.parse(readFileSync(join(source, 'snapshot.json'), 'utf8'));
if (!existsSync(target)) cpSync(source, target, { recursive: true, errorOnExist: true });
else {
  const existing = JSON.parse(readFileSync(join(target, 'snapshot.json'), 'utf8'));
  if (existing.inputPreparation?.kind === 'runtime-evidence-refresh') throw new Error('Completed refreshed input must be preserved');
}
const restored = restoreSnapshot({ snapshotsDir: snapshots, name: 'oversize-axes3-diagnostic-v2',
  targetSlug: meta.slug, expectedTask: 'oversize' });
const paths = new WitokPaths(restored.root, meta.slug);
const previous = JSON.parse(readFileSync(paths.chunkEvidence(1, 1), 'utf8'));
const result = await recordAttemptEvidence({
  projectRoot: restored.root, diffPath: paths.chunkDiff(1, 1), testsPath: paths.chunkTests(1, 1),
  evidencePath: paths.chunkEvidence(1, 1), diffBefore: '', baseSha: previous.base_sha,
  gateCtx: { projectRoot: restored.root, planFiles: [], baseline: null, timeoutMs: 120000 },
  runTests: async (ctx) => {
    const result = await runGateByName('Тесты', { ...ctx, gates: loadGates(paths.gates), projectName: 'diagnostic-reference' }, ctx);
    if (result === null) throw new Error('Declared test gate missing');
    return result;
  }, meta: { slug: meta.slug, chunk: 1, attempt: 1, executorModel: previous.executor_model ?? null },
});
if (result.testsStatus !== '✅') throw new Error(`Reference input tests failed: ${result.testsNote}`);
const targetPaths = new WitokPaths(target, meta.slug);
for (const [from, to] of [[paths.chunkDiff(1, 1), targetPaths.chunkDiff(1, 1)],
  [paths.chunkTests(1, 1), targetPaths.chunkTests(1, 1)], [paths.chunkEvidence(1, 1), targetPaths.chunkEvidence(1, 1)]]) cpSync(from, to);
restored.dispose();
writeFileSync(join(target, 'snapshot.json'), JSON.stringify({ ...meta,
  inputPreparation: { kind: 'runtime-evidence-refresh', source: 'oversize-axes3-diagnostic-v2',
    sourceHash: treeDigest(source), preparedAt: new Date().toISOString(), testsStatus: result.testsStatus,
    solutionCodeChanged: false },
}, null, 2) + '\n', 'utf8');
console.log(`Recorded actual evidence: ${target}`);
