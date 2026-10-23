import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireTaskFiles } from '../src/tasks.ts';
import { runHiddenTests } from '../src/hiddenTests.ts';

const bench = fileURLToPath(new URL('..', import.meta.url));
for (const id of ['guided-transfer-window', 'guided-transfer-segments', 'guided-transfer-message']) {
  test(`${id}: original behavior is red, independently authored reference satisfies all cases`, async t => {
    const paths = requireTaskFiles(bench, id);
    const baseline = await runHiddenTests({ hiddenFile: paths.hiddenFile, targetDir: paths.fixtureDir });
    assert.equal(baseline.errorText, null);
    assert.ok(baseline.total > 0 && baseline.fail > 0);
    assert.ok(baseline.cases.filter(c => c.category === 'regression').every(c => c.ok));
    const root = mkdtempSync(join(tmpdir(), 'guided-transfer-reference-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(paths.fixtureDir, root, { recursive: true });
    const expected = JSON.parse(readFileSync(paths.expectedFile, 'utf8')) as { referenceFiles: Record<string, string> };
    for (const [path, text] of Object.entries(expected.referenceFiles)) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
    }
    const accepted = await runHiddenTests({ hiddenFile: paths.hiddenFile, targetDir: root });
    assert.equal(accepted.errorText, null);
    assert.equal(accepted.total, baseline.total);
    assert.equal(accepted.skipped, 0);
    assert.equal(accepted.fail, 0, JSON.stringify(accepted));
  });
}
