import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INPUTS, assertEngineLog, assertExactPair, assertFrozen, assertPair, baselineText, collectEvidence, comparisonSpec,
  coordinatorHash, inventory, lessonStatus, recoverInterrupted, remainingRunMs, report, schedule, stableDigest,
  comparisonRawLogDir, collectComparisonEvidence } from '../src/harnessComparison.ts';
import type { Manifest } from '../src/harnessComparison.ts';
import type { BenchResult } from '../src/result.ts';
import { assessGuidedValidation } from '../src/guidedValidation.ts';

const spec = comparisonSpec.parse({ version: 1, hypothesis: 'Explicit evidence contract improves completion', cue: 'Invalid answer', lesson: 'Return diagnostic feedback',
  model: 'ollama:example', modelConfig: 'config/models.json', tasks: ['first', 'unrelated'],
  change: { path: 'server/src/protocol.ts', before: 'old contract', after: 'new contract' },
  limits: { attempts: 3, stageMinutes: 15, runMinutes: 30 }, engine: { host: 'http://127.0.0.1:1234', cache: 'q8_0', context: 32768, gpuFreeMiB: [100], gpuUtilMax: [10] } });
test('engine allocation verification supports both log formats and rejects flags without allocation', () => {
  const buffers = 'CUDA0 model buffer size = 8000 MiB\nCUDA1 model buffer size = 4000 MiB\n';
  assertEngineLog(buffers + 'llama_kv_cache: K (q8_0): 544 MiB, V (q8_0): 544 MiB', 2);
  assertEngineLog(buffers + "type_k = 'q8_0', type_v = 'q8_0'", 2);
  assert.throws(() => assertEngineLog(buffers + '--cache-type-k q8_0 --cache-type-v q8_0\n- type q8_0: 98 tensors', 2), /cache/u);
  assert.throws(() => assertEngineLog(buffers + 'K (q8_0), V (f16)', 2), /cache/u);
  assert.throws(() => assertEngineLog('CUDA0 model buffer size = 14000 MiB\nK (q8_0), V (q8_0)', 2), /distributed/u);
});
function manifest(): Manifest {
  return { version: 1, spec: structuredClone(spec), specHash: stableDigest(spec), preparedAt: new Date().toISOString(), status: 'prepared',
    nodeVersion: process.version, coordinatorHash: coordinatorHash(), inputs: { A: {}, B: {}, common: {} }, modelProfile: { id: spec.model, provider: 'ollama', model: 'example' }, cells: schedule(spec.tasks) };
}
test('declared change must be unique and the only difference, including additions/deletions', () => {
  assert.equal(baselineText('prefix new contract suffix', spec.change), 'prefix old contract suffix');
  assert.throws(() => baselineText('new contract new contract', spec.change));
  assert.throws(() => baselineText('unrelated', spec.change));
  const a = { [spec.change.path]: 'a', 'checks.ts': 'same' }, b = { ...a, [spec.change.path]: 'b' };
  assert.doesNotThrow(() => assertPair(a, b, spec.change));
  assert.throws(() => assertPair(a, { ...b, 'checks.ts': 'changed' }, spec.change));
  assert.throws(() => assertPair(a, { [spec.change.path]: 'b' }, spec.change));
  assert.throws(() => comparisonSpec.parse({ ...spec, change: { ...spec.change, path: '../escape' } }));
  assert.throws(() => comparisonSpec.parse({ ...spec, tasks: ['same', 'same'] }));
});
test('frozen identities detect configuration, methodology, code and settings drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-pair-'));
  try {
    for (const arm of ['A', 'B']) {
      for (const input of INPUTS) {
        const path = join(dir, 'snapshots', arm, input);
        if (input.includes('.json')) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{}'); }
        else mkdirSync(path, { recursive: true });
      }
      writeFileSync(join(dir, 'snapshots', arm, spec.change.path), arm === 'A' ? 'old contract' : 'new contract');
    }
    mkdirSync(join(dir, 'common')); writeFileSync(join(dir, 'common/prompts.md'), 'shared prompt');
    const m = manifest(); m.inputs = { A: inventory(join(dir, 'snapshots/A'), INPUTS), B: inventory(join(dir, 'snapshots/B'), INPUTS), common: inventory(join(dir, 'common')) };
    assertFrozen(dir, m); assertExactPair(join(dir, 'snapshots/A'), join(dir, 'snapshots/B'), spec.change);
    m.spec.limits.runMinutes++; assert.throws(() => assertFrozen(dir, m), /settings/u); m.spec = structuredClone(spec);
    writeFileSync(join(dir, 'common/prompts.md'), 'drift'); assert.throws(() => assertFrozen(dir, m), /Common/u);
    writeFileSync(join(dir, 'common/prompts.md'), 'shared prompt');
    writeFileSync(join(dir, 'snapshots/B/config/models.json'), '{"changed":true}'); assert.throws(() => assertFrozen(dir, m), /inputs changed/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('resume retains completed evidence and abandons an incomplete invocation without claiming success', () => {
  const cells = schedule(spec.tasks); assert.deepEqual(cells.map(c => c.arm), ['A', 'B', 'B', 'A']);
  cells[0]!.status = 'complete'; cells[1]!.status = 'running'; cells[1]!.invocations.push({ slug: 'old', startedAt: 'then', pid: 42 });
  assert.throws(() => recoverInterrupted(cells, false, () => false));
  assert.throws(() => recoverInterrupted(cells, true, () => true), /alive/u);
  recoverInterrupted(cells, true, () => false);
  assert.equal(cells[0]!.status, 'complete'); assert.equal(cells[1]!.status, 'pending'); assert.equal(cells[1]!.invocations[0]!.abandoned, true);
  assert.equal(cells[1]!.outcome, undefined);
});
test('observed labels differ from missing metrics and token absence is never zero', () => {
  const empty = collectEvidence(null, []); assert.equal(empty.inputTokens, null); assert.equal(empty.rejectedClaims, null); assert.equal(empty.verifyReached, false);
  const result = { driver: { stages: [{ stage: 'verify', skipped: false }] }, metrics: { stages: [{ usage: { inputTokens: 12, outputTokens: 3 } }] } } as unknown as BenchResult;
  const e = collectEvidence(result, [{ target: 'claim-fill', accepted: false, reason: 'manual not allowed' }, { target: 'claim-fill', accepted: true }]);
  assert.equal(e.manualRejected, 1); assert.equal(e.rejectedClaims, 1); assert.equal(e.claimCalls, 2); assert.equal(e.inputTokens, 12); assert.equal(e.verifyReached, true);
});
test('restart cannot reset the model-run budget and unknown crash duration is charged conservatively', () => {
  const cell = schedule(spec.tasks)[0]!;
  cell.invocations.push({ slug: 'first', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:10Z', abandoned: true });
  assert.equal(remainingRunMs(cell, 30000), 20000);
  cell.invocations.push({ slug: 'crashed', startedAt: '2026-01-01T00:00:20Z', abandoned: true });
  assert.equal(remainingRunMs(cell, 30000), 0);
});
test('reports preserve unavailable outcomes, Verify failures, timeout and environment reasons', () => {
  const m = manifest(); m.status = 'environment-failure'; m.error = 'engine unavailable';
  m.cells[0]!.status = 'complete'; m.cells[0]!.outcome = { status: 'no-current-result', success: false, reason: 'No current result', exitCode: null, diagnosis: 'unassessed',
    outcomeKind: 'incomplete', evidenceLevel: 'none', modelQualitySuccess: false, modelTaskEvaluated: false, operationalSuccess: false, environmentFailure: false };
  m.cells[1]!.error = 'Wall-clock run timeout';
  const text = report(m); assert.match(text, /неизвестно/u); assert.match(text, /engine unavailable/u); assert.match(text, /No current result/u); assert.match(text, /Wall-clock run timeout/u);
  assert.equal(lessonStatus(m), 'candidate');
  m.status = 'complete'; assert.equal(lessonStatus(m), 'candidate', 'Missing branch evidence must not promote lessons');
});
test('pilot support requires the target failure, exercised repair and success on both tasks', () => {
  const m = manifest(); m.status = 'complete';
  const base = assessGuidedValidation(null, { slug: 'example', model: spec.model, task: spec.tasks[0]!, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' }, 0);
  const exchange = { request: { messages: [{ role: 'user', content: JSON.stringify({ data: { facts: { claim: { manualAllowed: false } } } }) }] },
    response: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'manual' }) } }] }) };
  for (const cell of m.cells) {
    cell.status = 'complete'; cell.outcome = { ...base, status: cell.arm === 'B' ? 'success' : 'failed', success: cell.arm === 'B' };
    cell.evidence = { ...collectEvidence(null, [{ target: 'claim-fill', accepted: false, reason: 'manual forbidden', exchange }]), verifyReached: true };
  }
  assert.equal(lessonStatus(m), 'supported-in-pilot');
  m.cells[0]!.evidence!.invalidManualAnswers = 0; assert.equal(lessonStatus(m), 'candidate');
  m.cells[0]!.evidence!.invalidManualAnswers = 1;
  m.cells[2]!.outcome = { ...base, success: false }; assert.equal(lessonStatus(m), 'candidate');
  m.cells[2]!.outcome = { ...base, success: true, status: 'success' };
  m.cells[1]!.evidence!.manualRejected = 0; assert.equal(lessonStatus(m), 'candidate');
});

test('launcher raw path reaches the actual writer, annotations and evidence collector', t => {
  const snapshot = mkdtempSync(join(tmpdir(), 'comparison-raw-'));
  t.after(() => rmSync(snapshot, { recursive: true, force: true }));
  const rawLogDir = comparisonRawLogDir(snapshot), slug = 'sample-run';
  const module = new URL('../../server/src/provider/rawLog.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { dumpExchange, annotateExchange } from ${JSON.stringify(module)};
    const path = dumpExchange({ slug: ${JSON.stringify(slug)}, stage: 'verify', mode: 'claimFill' },
      { provider: 'test', model: 'test', status: 200, durationMs: 1,
        request: { messages: [{ role: 'user', content: JSON.stringify({ data: { facts: { claim: { manualAllowed: false } } } }) }] },
        response: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'manual' }) } }] }) });
    annotateExchange(path, { target: 'claim-fill', accepted: false, oracle: 'guided-json-parse', reason: 'manual forbidden' });
  `], { cwd: snapshot, env: { ...process.env, SDLC_RAW_LOG_DIR: rawLogDir }, windowsHide: true });
  const evidence = collectComparisonEvidence(null, snapshot, { slug, rawLogDir });
  assert.equal(evidence.traceCollection?.status, 'complete');
  assert.equal(evidence.claimCalls, 1);
  assert.equal(evidence.manualRejected, 1);
  assert.equal(evidence.invalidManualAnswers, 1);
  const dir = join(rawLogDir, slug);
  const label = readdirSync(dir).find(n => n.endsWith('.label.json'))!;
  const original = readFileSync(join(dir, label), 'utf8');
  writeFileSync(join(dir, label), '{');
  const broken = collectComparisonEvidence(null, snapshot, { slug, rawLogDir });
  assert.equal(broken.traceCollection?.status, 'incomplete');
  assert.equal(broken.claimCalls, null);
  writeFileSync(join(dir, label), original);
  rmSync(join(dir, label));
  assert.match(collectComparisonEvidence(null, snapshot, { slug, rawLogDir }).traceCollection!.errors.join(), /метка/);
});

test('legacy recovery is explicit and missing traces never become zero failures', t => {
  const snapshot = mkdtempSync(join(tmpdir(), 'comparison-legacy-'));
  t.after(() => rmSync(snapshot, { recursive: true, force: true }));
  const slug = 'old-run', dir = join(snapshot, '1', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'one.json'), JSON.stringify({ slug, mode: 'claimFill' }));
  writeFileSync(join(dir, 'one.json.label.json'), JSON.stringify({ target: 'claim-fill', accepted: true }));
  assert.equal(collectComparisonEvidence(null, snapshot, { slug }).claimCalls, 1);
  const missing = collectComparisonEvidence(null, snapshot, { slug, rawLogDir: comparisonRawLogDir(snapshot) });
  assert.equal(missing.traceCollection?.status, 'incomplete');
  assert.equal(missing.rejectedClaims, null);
});

test('declared manual experiment matches current code and keeps related requirements in both arms', () => {
  const spec = comparisonSpec.parse(JSON.parse(readFileSync(new URL('../experiments/harness-verify-claims.json', import.meta.url), 'utf8')));
  const source = readFileSync(new URL('../../server/src/run/guidedVerificationProtocol.ts', import.meta.url), 'utf8');
  const baseline = baselineText(source, spec.change);
  assert.notEqual(baseline, source);
  assert.ok(baseline.includes('const contractClaims = i.contractClaims ?? i.claims'));
  assert.ok(source.includes('const contractClaims = i.contractClaims ?? i.claims'));
  assert.ok(baseline.includes('rejectionContract'), 'The manual experiment must preserve rejection validation');
});
