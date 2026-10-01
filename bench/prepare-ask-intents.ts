/** Repair two recorded intent inputs before obtaining a real full-contour exploration. */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { writeIntentSnapshot } from '../server/src/artifacts/intentSections.ts';
import { treeDigest } from './src/diagnostics.ts';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));

for (const item of [
  { source: 'diagnostic-two-right-answers-explore-v1', dest: 'two-right-answers-intent-reference-v1',
    question: 'remove-code-answer-question' },
  { source: 'diagnostic-impossible-without-data-explore-v1', dest: 'impossible-without-data-intent-reference-v1',
    question: 'reopen-human-decision' },
] as const) {
  const from = join(snapshots, item.source);
  const to = join(snapshots, item.dest);
  if (existsSync(to)) { console.log(`${item.dest}: already present`); continue; }
  cpSync(from, to, { recursive: true, errorOnExist: true });
  const metaFile = join(to, 'snapshot.json');
  const sourceMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const paths = new WitokPaths(to, sourceMeta.slug);
  let intent = readFileSync(paths.intent, 'utf8');
  const contour = /^- \*\*Контур:\*\* мелкий[^\r\n]*\r?\n[^\r\n]*\r?\n/m;
  if (!contour.test(intent)) throw new Error(`${item.dest}: small-contour marker changed`);
  intent = intent.replace(contour, '- **Контур:** полный\n');
  if (item.question === 'remove-code-answer-question') {
    const question = /^- \[x\] \*\*\[блокирующий\]\*\* Какой способ переноса брони[^\r\n]*\r?\n/m;
    if (!question.test(intent)) throw new Error(`${item.dest}: code-answer question changed`);
    intent = intent.replace(question, '- нет открытых вопросов\n');
    intent = intent.replace(/(- нет открытых вопросов\r?\n){2}/, '- нет открытых вопросов\n');
  } else {
    const answered = /^- \[x\] \*\*\[блокирующий\]\*\* (Какой коэффициент упаковки[^?\r\n]*\?)[^\r\n]*\r?\n/m;
    if (!answered.test(intent)) throw new Error(`${item.dest}: coefficient question changed`);
    intent = intent.replace(answered, '- [ ] **[блокирующий]** $1\n');
  }
  writeFileSync(paths.intent, intent);
  writeIntentSnapshot(paths.intentSections, intent);
  rmSync(paths.clarificationReport, { force: true });
  writeFileSync(metaFile, JSON.stringify({ ...sourceMeta, authorModel: 'reference:curated',
    stoppedAfterStage: 'intent', createdAt: new Date().toISOString(),
    inputPreparation: { kind: 'reviewed-reference', source: item.source, sourceAuthorModel: sourceMeta.authorModel,
      sourceHash: treeDigest(from), changes: ['corrected task-required full contour',
        item.question === 'remove-code-answer-question' ? 'removed question answered by code' : 'reopened unanswered coefficient question',
        'removed premature clarification report'] } }, null, 2) + '\n');
  console.log(`${item.dest}: ready for explore`);
}
