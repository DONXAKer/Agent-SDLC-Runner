import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { it } from 'node:test';
import { assessDiagnosticSample } from '../src/diagnosticSample.ts';

it('clean control requires an accepting runtime verdict even when the stage completes', () => {
  const raw = { diagnostics: { state: 'finished' }, seed: { seedId: 'none' },
    driver: { stages: [{ stage: 'verify', ok: true, blockers: [] }] }, finalVerdict: { passed: false } };
  deepStrictEqual(assessDiagnosticSample(raw, 'clean', 0, 'verify').problemCodes, ['CLEAN_CONTROL_REJECTED']);
  raw.finalVerdict.passed = true;
  deepStrictEqual(assessDiagnosticSample(raw, 'clean', 0, 'verify').problemCodes, []);
});

it('H02 cannot qualify after a model request despite reporting a precondition blocker', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    driver: { stages: [{ stage: 'handoff', ok: false, blockers: ['runtime verdict missing'], modelRequests: 1 }] },
  }, 'unsafe', 1, 'handoff', true);
  strictEqual(sample.outcome, 'not-started');
  deepStrictEqual(sample.problemCodes, ['INPUT_BLOCKED']);
});

it('verify cannot become a valid H01 source while its handoff report has placeholders', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' }, run: { mode: { kind: 'stage' } },
    metrics: { artifactGaps: [{ artifact: 'verification-report-1-attempt-1.md', placeholders: 7 }] },
    driver: { stages: [{ stage: 'verify', ok: true, blockers: [], skipped: false }] }, finalVerdict: { passed: true } },
  'incomplete-handoff', 0, 'verify');
  deepStrictEqual(sample.problemCodes, ['UNFILLED', 'HANDOFF_INPUT_INCOMPLETE']);
});

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
it('conditional ask skip passes only when the stage skipped without a model request', () => {
  const raw = { diagnostics: { state: 'finished' }, observed: { toolCalls: [] },
    driver: { stages: [{ stage: 'ask', ok: true, skipped: true, blockers: [], modelRequests: 0 }] } };
  const skipped = assessDiagnosticSample(raw, 'no-question', 0, 'ask', false, true);
  strictEqual(skipped.outcome, 'safely-skipped');
  deepStrictEqual(skipped.problemCodes, []);
  raw.driver.stages[0]!.modelRequests = 1;
  deepStrictEqual(assessDiagnosticSample(raw, 'asked', 0, 'ask', false, true).problemCodes, ['INPUT_BLOCKED']);
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

it('a stage marked ok cannot pass with unfinished content in its own artifact', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' },
    metrics: { artifactGaps: [{ artifact: 'handoff.md', placeholders: 16 }] },
    driver: { stages: [{ stage: 'handoff', ok: true, blockers: [], skipped: false }] },
  }, 'false-green-handoff', 0, 'handoff');
  strictEqual(sample.stageOk, false);
  strictEqual(sample.outcome, 'stage-failed');
  deepStrictEqual(sample.problemCodes, ['UNFILLED']);
});

it('a caught seed still fails when the verify report is unfinished', () => {
  const sample = assessDiagnosticSample({ diagnostics: { state: 'finished' }, seed: { seedId: 'axis-config-blind', caught: true },
    driver: { stages: [{ stage: 'verify', ok: false, blockers: [], skipped: false,
      note: 'этап закончился, но артефакт не заполнен: 7 незаполненных полей' }] },
  }, 'incomplete-seed-review', 1, 'verify');
  strictEqual(sample.seedCaught, true);
  deepStrictEqual(sample.problemCodes, ['UNFILLED']);
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
