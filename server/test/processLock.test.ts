import { test } from 'node:test';
import { equal, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLock, adoptProcessLock, releaseProcessLock, assertProcessesExited } from '../src/fs/processLock.ts';

test('exclusive process lease protects the waiting phase and rejects another owner', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-lease-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'lease');
  const token = acquireProcessLock(path);
  throws(() => acquireProcessLock(path), /EEXIST/);
  throws(() => adoptProcessLock(path, 'other'), /changed/);
  throws(() => releaseProcessLock(path, 'other'), /changed/);
  adoptProcessLock(path, token);
  equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  releaseProcessLock(path, token);
  releaseProcessLock(path, acquireProcessLock(path));
});

test('cleanup checks benchmark children even after their coordinator exited', () => {
  const inspected: number[] = [];
  throws(() => assertProcessesExited([101, 202], pid => { inspected.push(pid); return pid === 202; }), /202/);
  deepStrictEqual(inspected, [101, 202]);
});
