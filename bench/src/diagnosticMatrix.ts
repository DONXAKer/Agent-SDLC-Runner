/** Inventory stage-specific diagnostic cases without invoking any model. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskById, taskPaths } from './tasks.ts';
import { startStageAfter } from './snapshot.ts';

const benchDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const casesFile = join(benchDir, 'diagnostics', 'cases.json');
const snapshotsDir = join(benchDir, 'snapshots');
const manifest = JSON.parse(readFileSync(casesFile, 'utf8')) as {
  cases: Array<{ id: string; task: string; stage: string; snapshotAfter: string | null; snapshot?: string; seed?: string; evaluation: string }>;
};
const snapshots = new Map<string, { task: string; stoppedAfterStage: string }>();
for (const name of readdirSync(snapshotsDir)) {
  const path = join(snapshotsDir, name, 'snapshot.json');
  if (!existsSync(path)) continue;
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')) as { task?: string; stoppedAfterStage?: string };
    if (meta.task && meta.stoppedAfterStage) snapshots.set(name, { task: meta.task, stoppedAfterStage: meta.stoppedAfterStage });
  } catch { /* malformed snapshots are unavailable inputs */ }
}

const rows = manifest.cases.map((c) => {
  const task = taskById(c.task);
  const files = taskPaths(benchDir, task);
  const missingFiles = [files.taskFile, files.humanFile, files.expectedFile, files.hiddenFile].filter((p) => !existsSync(p));
  let snapshot = c.snapshot;
  if (c.snapshotAfter !== null && snapshot === undefined) {
    snapshot = [...snapshots].find(([, meta]) => meta.task === c.task && meta.stoppedAfterStage === c.snapshotAfter)?.[0];
  }
  let status: string;
  let reason: string;
  if (missingFiles.length) {
    status = 'missing-task-input'; reason = missingFiles.map((p) => p.replace(benchDir, 'bench')).join(', ');
  } else if (c.snapshotAfter === null) {
    status = 'input-present'; reason = 'fixture input';
  } else if (snapshot === undefined) {
    status = 'missing-snapshot'; reason = `need a validated ${c.task} snapshot after ${c.snapshotAfter}`;
  } else {
    const meta = snapshots.get(snapshot);
    if (meta === undefined) {
      status = 'missing-snapshot'; reason = `need snapshot ${snapshot} after ${c.snapshotAfter}`;
    } else {
      const start = startStageAfter(meta.stoppedAfterStage);
      if (meta.task !== c.task || meta.stoppedAfterStage !== c.snapshotAfter || start !== c.stage) {
        status = 'invalid-snapshot'; reason = `${snapshot} does not start ${c.stage} for ${c.task}`;
      } else {
        status = 'input-present'; reason = `${snapshot} (author: ${metaAuthor(snapshot) ?? 'unknown'})`;
      }
    }
  }
  return { id: c.id, task: c.task, stage: c.stage, status, input: reason, seed: c.seed ?? '', evaluation: c.evaluation };
});

if (process.argv.includes('--json')) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), modelCalls: 0, cases: rows }, null, 2));
else {
  console.log('| ID | Task | Stage | Input status | Source | Seed | Evaluation |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.task} | ${r.stage} | ${r.status} | ${r.input} | ${r.seed} | ${r.evaluation} |`);
  console.log(`\n${rows.filter((r) => r.status === 'input-present').length}/${rows.length} cases have an input directory and matching metadata. This does not certify semantic validity. No model calls were made.`);
}

function metaAuthor(name: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(snapshotsDir, name, 'snapshot.json'), 'utf8')) as { authorModel?: unknown };
    if (typeof parsed.authorModel === 'string') return parsed.authorModel;
    const authors = new Set<string>();
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile() && /(?:evidence.*|.*-evidence)\.json$/i.test(entry.name)) {
          try {
            const evidence = JSON.parse(readFileSync(path, 'utf8')) as { executor_model?: unknown };
            if (typeof evidence.executor_model === 'string') authors.add(evidence.executor_model);
          } catch { /* no provenance from unreadable evidence */ }
        }
      }
    };
    const artifacts = join(snapshotsDir, name, '.sdlc');
    if (existsSync(artifacts)) scan(artifacts);
    return authors.size === 1 ? [...authors][0]! : null;
  } catch { return null; }
}
