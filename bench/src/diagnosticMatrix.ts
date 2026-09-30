/** Inventory stage-specific diagnostic cases without invoking any model. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDiagnosticInput, type DiagnosticCase } from './diagnosticInputs.ts';

const benchDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const casesFile = join(benchDir, 'diagnostics', 'cases.json');
const snapshotsDir = join(benchDir, 'snapshots');
const manifest = JSON.parse(readFileSync(casesFile, 'utf8')) as {
  cases: DiagnosticCase[];
};

const rows = manifest.cases.map((c) => {
  const input = checkDiagnosticInput(benchDir, c);
  return { id: c.id, task: c.task, stage: c.stage,
    status: input.status === 'available' ? 'input-present' : input.status,
    input: input.reason, author: input.snapshot ? metaAuthor(input.snapshot) : null,
    seed: c.seed ?? '', evaluation: c.evaluation };
});

if (process.argv.includes('--json')) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), modelCalls: 0, cases: rows }, null, 2));
else {
  console.log('| ID | Task | Stage | Input status | Source | Seed | Evaluation |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.task} | ${r.stage} | ${r.status} | ${r.input.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${r.seed} | ${r.evaluation} |`);
  console.log(`\n${rows.filter((r) => r.status === 'input-present').length}/${rows.length} inputs pass metadata and stage preconditions. Semantic validity requires rubric review. No model calls were made.`);
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
