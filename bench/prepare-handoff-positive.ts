/** Preserve a passed local verify attempt after removing unused template rows from its report. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { countPlaceholdersExceptDecisions } from '../server/src/artifacts/artifact.ts';
import { makeSnapshot, snapshotRuntimeVerdict, type SnapshotMeta } from './src/snapshot.ts';
import { ensureBenchStateDir } from './src/stateDir.ts';

ensureBenchStateDir();

const [workspaceRoot, slug, name, resultFile] = process.argv.slice(2);
if (!workspaceRoot || !slug || !name || !resultFile) {
  throw new Error('usage: node bench/prepare-handoff-positive.ts <workspace> <slug> <snapshot-name> <result.json>');
}
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`invalid snapshot name: ${name}`);
const result = JSON.parse(readFileSync(resultFile, 'utf8'));
if (result.driver?.finalVerdict?.passed !== true || result.driver?.stopped !== 'stage-measured') {
  throw new Error('source result has no successful measured verify verdict');
}
const snapshotsDir = fileURLToPath(new URL('./snapshots/', import.meta.url));
const dest = join(snapshotsDir, name);
if (existsSync(dest)) throw new Error(`refusing to replace existing snapshot: ${name}`);
const sourcePaths = new WitokPaths(workspaceRoot, slug);
const sourceReport = readFileSync(sourcePaths.verificationReport(1, 1), 'utf8');
const cleaned = sourceReport.split(/\r?\n/).filter((line) => !/^\|\s*‹гейт›\s*\|/.test(line)).join('\n');
if (cleaned === sourceReport || countPlaceholdersExceptDecisions(cleaned) !== 0) {
  throw new Error('only unused gate template rows may be removed; report still has unresolved fields');
}
makeSnapshot({ workspaceRoot, snapshotsDir, name, slug, branch: 'sdlc/oversize',
  stoppedAfterStage: 'verify', task: 'oversize', authorModel: 'ollama:gemma4-12b-compactfill', chunk: 1, attempt: 1 });
const metaFile = join(dest, 'snapshot.json');
const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as SnapshotMeta;
if (!snapshotRuntimeVerdict(dest, meta)) throw new Error('the source runtime verdict does not match the copied attempt');
writeFileSync(new WitokPaths(dest, slug).verificationReport(1, 1), cleaned);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
writeFileSync(metaFile, JSON.stringify({ ...meta, inputPreparation: {
  kind: 'template-row-cleanup', sourceResult: resultFile, sourceResultHash: hash(readFileSync(resultFile, 'utf8')),
  reportBeforeHash: hash(sourceReport), reportAfterHash: hash(cleaned),
  change: 'removed only unused ‹гейт› example rows; no findings, claims, verdict, or source code edited',
} }, null, 2) + '\n');
if (!snapshotRuntimeVerdict(dest, meta)) throw new Error('runtime verdict became invalid after template cleanup');
console.log(`Positive handoff input prepared: ${name}`);
