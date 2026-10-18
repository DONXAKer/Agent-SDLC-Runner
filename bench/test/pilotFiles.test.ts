import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPilotFiles } from '../../tools/pilot-files.ts';

test('pilot validates every entry and required file before any mutation', t => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-transaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'original');
  for (const files of [
    [{ path: 'a.ts', content: 'changed' }, { path: '../outside.ts', content: 'bad' }],
    [{ path: 'a.ts', content: 'changed' }],
    [{ path: 'a.ts', content: 'changed' }, '{"path":"b.ts","content":"stringified"}'],
    [{ path: 'a.ts', content: 'changed' }, { path: 'a.ts', content: 'duplicate' }],
  ]) {
    assert.throws(() => applyPilotFiles(root, ['a.ts', 'b.ts'], { files }));
    assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'original');
    assert.equal(existsSync(join(root, 'b.ts')), false);
  }
  applyPilotFiles(root, ['a.ts', 'b.ts'], { files: [{ path: 'a.ts', content: 'changed' }, { path: 'b.ts', content: 'new' }] });
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'changed');
  assert.equal(readFileSync(join(root, 'b.ts'), 'utf8'), 'new');
});
