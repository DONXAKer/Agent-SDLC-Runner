import { strictEqual, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { emptyUsage } from '@sdlc-runner/shared';
import type { PreparedPrompt } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { Run } from '../src/run/Run.ts';
import { runReviewerDirectly } from '../src/run/stages/verify/reviewer.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ExecHooks } from '../src/exec/StageExecutor.ts';
import { parseReviewText } from '../src/run/stages/verify/reviewValidate.ts';
import { writeRunVerdict } from '../src/run/verdictStore.ts';
import { handoffStage } from '../src/run/stages/handoff.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-closure-'));
after(() => rmSync(root, { recursive: true, force: true }));
const valid = JSON.stringify({ schema_version: 'agent-sdlc/verify-review/v1', claims: [], findings: [], scope: [], invariants: [], regressions: [], retry_instruction: '' });

async function review(replies: { text: string; ok?: boolean }[]) {
  const prompts: string[] = [];
  let marked = false;
  const host = {
    id: 'test', paths: new WitokPaths(root, 'test'), projectRoot: root,
    aborterSignal: () => new AbortController().signal,
    toolsFor: () => ['Read'], emit: () => {},
    verifyRoute: () => ({ model: 'test', providerDef: {} }),
    reviewScan: () => ({ route: { model: 'test', provider: 'test', providerDef: {} }, blocking: true }),
    readOnlyRoots: () => [], mcpAccess: async () => [], maxTurnsFor: () => 1,
    spentBefore: () => 0, chunk: () => 1, attempt: () => 1,
    intentClaimLines: () => new Map(), verifyState: {},
    markReviewerRan: () => { marked = true; },
    executorFor: () => ({ run: async (request: { prompt: PreparedPrompt }) => {
      prompts.push(request.prompt.user);
      const reply = replies[prompts.length - 1];
      if (reply === undefined) throw new Error('unexpected extra request');
      return { ok: reply.ok ?? true, finalText: reply.text, usage: emptyUsage(), note: 'test' };
    } }),
  } as unknown as StageHost;
  const text = await runReviewerDirectly(host, { user: 'review' } as PreparedPrompt,
    [{ name: 'sdlc-reviewer', description: 'test', model: null, prompt: 'review', tools: ['Read'] }], {} as ExecHooks);
  return { prompts, marked, text };
}

it('второй repair получает последнюю ошибку и сохраняет предыдущие ответы', async () => {
  const result = await review([{ text: 'первый дефект' }, { text: '{"claims":"wrong"}' }, { text: valid }]);
  strictEqual(result.prompts.length, 3);
  strictEqual(result.marked, true);
  const latestError = parseReviewText('{"claims":"wrong"}', new Set(), new Set()).errors.join('; ');
  ok(result.prompts[2]?.includes(`ошибки: ${latestError}`));
  ok(result.prompts[2]?.includes('{"claims":"wrong"}'));
  ok(result.text?.includes('первый дефект'));
  ok(result.text?.startsWith(valid));
});

it('три невалидных ответа не подтверждают факт ревью', async () => {
  const result = await review([{ text: 'bad1' }, { text: 'bad2' }, { text: 'bad3' }]);
  strictEqual(result.prompts.length, 3);
  strictEqual(result.marked, false);
});

it('ошибка запроса repair останавливает повторы', async () => {
  const result = await review([{ text: 'bad' }, { text: '', ok: false }]);
  strictEqual(result.prompts.length, 2);
  strictEqual(result.marked, false);
  strictEqual(result.text, null);
});

it('переходы статуса сохраняют начало ожидания и очищают его после ответа', () => {
  const run = Object.create(Run.prototype) as Run;
  run.status = 'running';
  strictEqual(run.awaitingSince, null);
  run.status = 'awaiting';
  const since = run.awaitingSince;
  ok(typeof since === 'number');
  run.status = 'awaiting';
  strictEqual(run.awaitingSince, since);
  run.status = 'cancelled';
  strictEqual(run.awaitingSince, null);
});

it('устаревший зелёный патч предлагает Verify для advance и handoff', () => {
  const paths = new WitokPaths(root, 'stale');
  const patch = paths.chunkDiff(1, 1);
  mkdirSync(join(patch, '..'), { recursive: true });
  writeFileSync(patch, 'old');
  writeRunVerdict(paths, 1, 1, { passed: true, action: 'continue', reasons: [] });
  writeFileSync(patch, 'new patch');
  const run = Object.create(Run.prototype) as Run;
  Object.assign(run, { paths, chunk: 1, attempt: 1 });
  for (const to of ['attempt', 'chunk'] as const) ok(run.advanceProblem(to)?.includes('повтори verify'));
  const check = handoffStage.requires[0]?.check;
  ok(check);
  ok(check({ paths, chunk: 1, attempt: 1 } as Parameters<NonNullable<typeof check>>[0])?.includes('повтори verify'));
});
