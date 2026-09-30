import { deepStrictEqual, notStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { emptyUsage } from '@sdlc-runner/shared';
import type { Run } from '../../server/src/run/Run.ts';
import { observeArtifacts, passport, treeDigest } from '../src/diagnostics.ts';
import { parseArgs } from '../src/options.ts';
import { runBench } from '../src/driver.ts';

describe('stage diagnostics', () => {
  it('captures a successful stage input after its human approval is recorded', async () => {
    const order: string[] = [];
    const run = { chunk: 1, attempt: 1, lastVerdict: null, blockerDetails: () => [],
      runStage: async () => { order.push('run'); return { ok: true, usage: emptyUsage(), finalText: 'filled', note: '' }; },
      recordDecision: () => { order.push('approval'); },
    } as unknown as Run;
    await runBench({ run, startStage: 'plan', measurementEnd: 'plan', attempts: 1,
      stageTimeoutMs: 1000, runTimeoutMs: 2000, onStageCompleted: () => { order.push('capture'); } });
    deepStrictEqual(order, ['run', 'approval', 'capture']);
    strictEqual(parseArgs(['--model', 'x', '--all', '--capture-inputs']).captureInputs, true);
    throws(() => parseArgs(['--model', 'x', '--stage', 'plan', '--capture-inputs']));
  });
  it('accepts a stage boundary and rejects an earlier boundary or snapshot combination', () => {
    strictEqual(parseArgs(['--model', 'x', '--stage', 'plan', '--stop-after-stage', 'plan']).stopAfterStage, 'plan');
    throws(() => parseArgs(['--model', 'x', '--stage', 'plan', '--stop-after-stage', 'intent']));
    throws(() => parseArgs(['--model', 'x', '--stage', 'plan', '--stop-after-stage', 'plan', '--make-snapshot', 'x']));
  });

  it('never enters a downstream stage when the measured stage fails', async () => {
    const calls: string[] = [];
    const run = {
      chunk: 1, attempt: 1, lastVerdict: null, blockerDetails: () => [],
      runStage: async (stage: string) => {
        calls.push(stage);
        return { ok: false, finalText: 'unfilled', usage: emptyUsage(), note: 'unfilled' };
      },
    } as unknown as Run;
    const result = await runBench({ run, startStage: 'plan', measurementEnd: 'plan', attempts: 1, stageTimeoutMs: 1000, runTimeoutMs: 2000 });
    deepStrictEqual(calls, ['plan']);
    strictEqual(result.stopped, 'stage-measured');
    strictEqual(result.stages[0]?.ok, false);
  });

  it('a completed input does not permit downstream work after a diagnostic timeout', async () => {
    let resolveStage!: (value: unknown) => void;
    const calls: string[] = [];
    const run = {
      chunk: 1, attempt: 1, lastVerdict: null, blockerDetails: () => [],
      runStage: (stage: string) => { calls.push(stage); return new Promise((resolve) => { resolveStage = resolve; }); },
      cancel: () => resolveStage({ ok: false, finalText: '', usage: emptyUsage(), note: 'timeout' }),
    } as unknown as Run;
    const result = await runBench({ run, startStage: 'plan', measurementEnd: 'plan', attempts: 1, stageTimeoutMs: 5, runTimeoutMs: 2000 });
    deepStrictEqual(calls, ['plan']);
    strictEqual(result.stopped, 'stage-timeout');
    strictEqual(result.stages[0]?.timedOut, true);
  });

  it('cancellation before a stage starts preserves the cancellation reason', async () => {
    const controller = new AbortController(); controller.abort();
    const run = { lastVerdict: null } as unknown as Run;
    const result = await runBench({ run, signal: controller.signal, attempts: 1, stageTimeoutMs: 1000, runTimeoutMs: 2000 });
    strictEqual(result.stopped, 'cancelled');
    deepStrictEqual(result.stages, []);
  });

  it('content hashes detect edits; a filled but nonsensical field is not called correct', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-diagnostic-'));
    try {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, 'report.md'), 'Задача: ‹задача›\n\n## Открытые вопросы\n- [ ] **[блокирующий]** ‹ставка?›\n- [ ] **[неблокирующий]** ‹пояснение?›');
      const before = treeDigest(root);
      strictEqual(observeArtifacts(root)[0]?.placeholders, 3);
      strictEqual(observeArtifacts(root)[0]?.uncheckedQuestions, 2);
      strictEqual(observeArtifacts(root)[0]?.blockingQuestions, 1);
      writeFileSync(join(root, 'report.md'), 'Задача: ✅');
      notStrictEqual(treeDigest(root), before);
      deepStrictEqual(Object.keys(observeArtifacts(root)[0]!).sort(), ['blockingQuestions', 'path', 'placeholders', 'sha256', 'uncheckedQuestions']);
      const after = treeDigest(root);
      writeFileSync(join(root, '.git', 'index'), 'metadata');
      strictEqual(treeDigest(root), after);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers a legacy snapshot author only from one explicit evidence model', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-passport-'));
    try {
      mkdirSync(join(root, '.sdlc', 'slug'), { recursive: true });
      writeFileSync(join(root, '.sdlc', 'slug', 'chunk-1-evidence.json'), JSON.stringify({ executor_model: 'claude-sdk:sonnet' }));
      const args = { repo: root, input: root, config: {}, snapshotName: 'old', stageTimeoutMs: 1, runTimeoutMs: 2 };
      strictEqual(passport(args).snapshotAuthor, 'claude-sdk:sonnet');
      writeFileSync(join(root, '.sdlc', 'slug', 'chunk-2-evidence.json'), JSON.stringify({ executor_model: 'ollama:qwen' }));
      strictEqual(passport(args).snapshotAuthor, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('hashes absolute external prompt roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-prompts-'));
    try {
      const prompt = join(root, 'methodology');
      mkdirSync(prompt);
      writeFileSync(join(prompt, 'skill.md'), 'version one');
      const args = { repo: root, input: root, config: {}, snapshotName: null, stageTimeoutMs: 1, runTimeoutMs: 2, promptRoots: [prompt] };
      const before = passport(args).sourceHash;
      writeFileSync(join(prompt, 'skill.md'), 'version two');
      notStrictEqual(passport(args).sourceHash, before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
