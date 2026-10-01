import { strictEqual, ok } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { reviewBaselineContext } from '../src/run/reviewBaseline.ts';

it('контекст базы отмечает только неизменённый файл, не скрывая последующую правку', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-baseline-'));
  try {
    const text = 'console.log("build");\n';
    const path = join(root, 'build.mjs');
    writeFileSync(path, text);
    const baseline = new Map([['build.mjs', createHash('sha256').update(text).digest('hex')]]);
    const diff = 'diff --git a/build.mjs b/build.mjs\n--- a/build.mjs\n+++ b/build.mjs\n@@ -1 +1 @@\n-old\n+new\n';
    ok(reviewBaselineContext(root, diff, baseline).includes('- build.mjs'));
    writeFileSync(path, text + 'console.log(process.env.SECRET);\n');
    strictEqual(reviewBaselineContext(root, diff, baseline), '');
    strictEqual(reviewBaselineContext(root, diff, null), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
