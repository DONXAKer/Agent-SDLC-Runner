import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { it } from 'node:test';
import { assessDiagnosticSample } from '../src/diagnosticSample.ts';

it('expected safety blocking is distinct from model failure and from a bypass', () => {
  const blocked = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    driver: { stages: [{ stage: 'handoff', ok: false, skipped: false, blockers: ['runtime verdict missing'] }] },
  }, 'negative', 1, 'handoff', true);
  strictEqual(blocked.outcome, 'safely-blocked');
  strictEqual(blocked.stageStarted, false);
  deepStrictEqual(blocked.problemCodes, []);
  const bypassed = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    driver: { stages: [{ stage: 'handoff', ok: true, skipped: false, blockers: [] }] },
  }, 'bypass', 0, 'handoff', true);
  deepStrictEqual(bypassed.problemCodes, ['EXPECTED_BLOCK_MISSING']);
});

it('unfinished evidence cannot qualify a mechanically successful stage', () => {
  for (const [state, exitCode] of [['running', 0], ['finished', null]] as const) {
    const sample = assessDiagnosticSample({ diagnostics: { state },
      driver: { stages: [{ stage: 'intent', ok: true, blockers: [], skipped: false }] },
    }, 'unfinished', exitCode, 'intent');
    strictEqual(sample.outcome, 'incomplete');
    deepStrictEqual(sample.problemCodes, ['INCOMPLETE']);
  }
});

it('a completed chunk with failed hidden checks remains a diagnostic failure', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' }, hidden: { fail: 2 },
    driver: { stages: [{ stage: 'chunk', ok: true, blockers: [], skipped: false }] },
  }, 'incorrect', 0, 'chunk');
  deepStrictEqual(sample.problemCodes, ['HIDDEN_TEST_FAILED']);
});

it('the clean control never suppresses a failed reviewer as a caught seed', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' }, seed: { seedId: 'none', caught: true },
    driver: { stages: [{ stage: 'verify', ok: false, blockers: [], skipped: false }] },
  }, 'control', 1, 'verify');
  strictEqual(sample.seedCaught, null);
  deepStrictEqual(sample.problemCodes, ['STAGE_FAILED']);
});

it('does not charge an unstarted verify stage with a missed seeded defect', () => {
  const sample = assessDiagnosticSample({
    diagnostics: { state: 'finished' }, seed: { caught: false },
    driver: { stages: [{ stage: 'verify', ok: false, skipped: false, timedOut: false,
      blockers: ['approved plan fingerprint is stale'] }] },
  }, 'blocked', 1, 'verify');
  strictEqual(sample.outcome, 'not-started');
  strictEqual(sample.seedCaught, null);
  deepStrictEqual(sample.problemCodes, ['INPUT_BLOCKED']);
});

it('keeps a timeout distinct from completed model findings', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    driver: { stages: [{ stage: 'intent', ok: false, timedOut: true, blockers: [], skipped: false }] },
  }, 'timeout', 1, 'intent');
  strictEqual(sample.stageStarted, true);
  strictEqual(sample.outcome, 'timeout');
  deepStrictEqual(sample.problemCodes, ['TIMEOUT']);
});

it('a caught seeded defect is the desired diagnostic result even with a red verify verdict', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' }, seed: { caught: true },
    driver: { stages: [{ stage: 'verify', ok: false, blockers: [], skipped: false }] },
  }, 'caught', 1, 'verify');
  strictEqual(sample.seedCaught, true);
  deepStrictEqual(sample.problemCodes, []);
});

it('does not infer a stage failure just from a benchmark probe exit code', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    driver: { stages: [{ stage: 'intent', ok: true, blockers: [], skipped: false }] },
  }, 'filled', 1, 'intent');
  strictEqual(sample.outcome, 'completed');
  deepStrictEqual(sample.problemCodes, []);
});
