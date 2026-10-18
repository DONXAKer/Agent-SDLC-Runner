/** Derive a negative handoff input from a real successful verify, withholding runtime approval. */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRuntimeVerdict, type SnapshotMeta } from './src/snapshot.ts';
import { ensureBenchStateDir } from './src/stateDir.ts';
import { treeDigest } from './src/diagnostics.ts';
import { placeholderRanges } from '../server/src/artifacts/artifact.ts';
import { WitokPaths } from '../server/src/artifacts/paths.ts';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
ensureBenchStateDir();
let created = 0;
for (const name of readdirSync(snapshots)) {
  const root = join(snapshots, name);
  const file = join(root, 'snapshot.json');
  if (!existsSync(file)) continue;
  const meta = JSON.parse(readFileSync(file, 'utf8')) as SnapshotMeta;
  if (meta.task !== 'oversize' || meta.stoppedAfterStage !== 'verify' || !snapshotRuntimeVerdict(root, meta)) continue;
  const paths = new WitokPaths(root, meta.slug);
  if (!existsSync(paths.verificationReport(1, 1))
    || placeholderRanges(readFileSync(paths.verificationReport(1, 1), 'utf8')).length > 0) continue;
  const target = join(snapshots, `${name}-missing-verdict`);
  if (existsSync(target)) continue;
  cpSync(root, target, { recursive: true });
  const { verdictSource: withheld, ...rest } = meta;
  writeFileSync(join(target, 'snapshot.json'), JSON.stringify({ ...rest,
    inputPreparation: { kind: 'missing-runtime-verdict', source: name, sourceHash: treeDigest(root),
      withheld: 'runtime verdict reference; report is retained to prove passed text alone cannot authorize commit' },
  }, null, 2) + '\n');
  created++;
}
console.log(`Negative handoff inputs prepared: ${created}`);
