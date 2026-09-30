import { deepStrictEqual, strictEqual, match } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { checkDiagnosticInput, diagnosticCliArgs, type DiagnosticCase } from '../src/diagnosticInputs.ts';
import { parseArgs } from '../src/options.ts';
import { taskById, taskPaths } from '../src/tasks.ts';

it('the real diagnostic command ends at the case boundary and keeps every local control route local', () => {
  const model = 'ollama:test';
  const c: DiagnosticCase = { id: 'I01', task: 'oversize', stage: 'intent', snapshotAfter: null, evaluation: 'scope' };
  const options = parseArgs(diagnosticCliArgs({ model, testCase: c, slug: 'test', timeoutMinutes: 2, snapshot: null, local: true }));
  strictEqual(options.stopAfterStage, 'intent');
  deepStrictEqual(Object.keys(options.controlOverrides).sort(), [...STAGE_ORDER].sort());
  strictEqual(Object.values(options.controlOverrides).every((value) => value === model), true);
});

it('matching metadata cannot certify a snapshot with a stale approved plan', () => {
  const bench = mkdtempSync(join(tmpdir(), 'diagnostic-input-'));
  try {
    const paths = taskPaths(bench, taskById('oversize'));
    for (const file of [paths.taskFile, paths.humanFile, paths.expectedFile, paths.hiddenFile]) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{}');
    }
    const root = join(bench, 'snapshots', 'stale');
    mkdirSync(join(root, '.sdlc', 'reference'), { recursive: true });
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ task: 'oversize', stoppedAfterStage: 'chunk', slug: 'reference' }));
    writeFileSync(join(root, '.sdlc', 'reference', 'plan.md'), `# План\n- **Требования (SHA-256):** ${'0'.repeat(64)}\n`);
    const input = checkDiagnosticInput(bench, { id: 'V00', task: 'oversize', stage: 'verify', snapshotAfter: 'chunk', snapshot: 'stale', evaluation: 'control' });
    strictEqual(input.status, 'invalid-snapshot');
    match(input.reason, /SHA-256/);
  } finally { rmSync(bench, { recursive: true, force: true }); }
});
