/** Explicit, mechanical migration of legacy benchmark inputs; never changes solution code or approvals. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { readArtifact } from '../server/src/artifacts/artifact.ts';
import { addRequirementsHash, readRequirementsHash, resolvedRequirementsHash } from '../server/src/artifacts/resolvedRequirements.ts';
import { stageById } from '../server/src/run/stages.ts';
import { treeDigest } from './src/diagnostics.ts';

const snapshots = resolve(fileURLToPath(new URL('snapshots', import.meta.url)));
for (const [name, stage] of [['vat-rounding-plan', 'chunk'], ['rename-field-plan', 'chunk'], ['oversize-axes3', 'verify']] as const) {
  const source = join(snapshots, name);
  const destination = join(snapshots, `${name}-diagnostic-v2`);
  if (existsSync(destination)) {
    const existingMeta = JSON.parse(readFileSync(join(destination, 'snapshot.json'), 'utf8'));
    const paths = new WitokPaths(destination, existingMeta.slug);
    const blockers = stageById(stage).requires.map((requirement) => requirement.check({ paths, chunk: 1, attempt: 1 }))
      .filter((reason) => reason !== null);
    if (blockers.length) throw new Error(`${destination}: ${blockers.join('; ')}`);
    if (!existingMeta.inputPreparation) {
      writeFileSync(join(destination, 'snapshot.json'), JSON.stringify({ ...existingMeta,
        inputPreparation: { kind: 'legacy-requirements-field', source: name, sourceHash: treeDigest(source),
          requirementHash: readRequirementsHash(readArtifact(paths.plan).text),
          validatedAt: new Date().toISOString(), semanticContentChanged: false },
      }, null, 2) + '\n', 'utf8');
    }
    console.log(`Validated existing ${destination}`); continue;
  }
  const meta = JSON.parse(readFileSync(join(source, 'snapshot.json'), 'utf8'));
  const sourcePaths = new WitokPaths(source, meta.slug);
  const plan = readArtifact(sourcePaths.plan);
  if (!plan.exists || readRequirementsHash(plan.text) !== null) throw new Error(`${name}: expected a legacy plan without a hash`);
  const intent = readArtifact(sourcePaths.intent);
  const clarification = readArtifact(sourcePaths.clarificationReport);
  const hash = resolvedRequirementsHash(intent.text, clarification.exists ? clarification.text : '');
  cpSync(source, destination, { recursive: true, errorOnExist: true });
  const paths = new WitokPaths(destination, meta.slug);
  writeFileSync(paths.plan, addRequirementsHash(plan.text, hash), 'utf8');
  const blockers = stageById(stage).requires.map((requirement) => requirement.check({ paths, chunk: 1, attempt: 1 }))
    .filter((reason) => reason !== null);
  if (blockers.length) throw new Error(`${name}: migrated input still invalid: ${blockers.join('; ')}`);
  writeFileSync(join(destination, 'snapshot.json'), JSON.stringify({ ...meta,
    inputPreparation: { kind: 'legacy-requirements-field', source: name, sourceHash: treeDigest(source),
      requirementHash: hash, preparedAt: new Date().toISOString(), semanticContentChanged: false },
  }, null, 2) + '\n', 'utf8');
  console.log(`Validated ${name}-diagnostic-v2 for ${stage}`);
}
