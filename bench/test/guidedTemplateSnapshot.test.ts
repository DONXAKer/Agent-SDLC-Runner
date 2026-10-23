import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '../../server/src/config/load.ts';

const directory = fileURLToPath(new URL('../fixtures/guided-process/', import.meta.url));
const snapshot = JSON.parse(readFileSync(join(directory, 'templates.json'), 'utf8')) as { hashes: Record<string, string> };
test('full guided fixture pins the actual methodology forms including independent acceptance', () => {
  assert.equal(Object.keys(snapshot.hashes).length, 10);
  for (const [name, hash] of Object.entries(snapshot.hashes))
    assert.equal(createHash('sha256').update(readFileSync(join(directory, 'templates', name))).digest('hex'), hash, name);
  assert.ok(readFileSync(join(directory, 'templates/verification-report.template.md'), 'utf8').includes('Независимые приёмочные проверки'));
});

test('configured methodology drift is visible instead of silently testing obsolete forms', t => {
  let source: string;
  try { source = join(loadConfig().runner.methodologyDir, 'templates'); }
  catch { t.skip('No external methodology configured; pinned snapshot still tested'); return; }
  if (!existsSync(source)) { t.skip('External methodology unavailable; pinned snapshot still tested'); return; }
  for (const name of Object.keys(snapshot.hashes))
    assert.deepEqual(readFileSync(join(source, name)), readFileSync(join(directory, 'templates', name)), name);
});
