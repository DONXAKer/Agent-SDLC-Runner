import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { emptyUsage, type StageId, type Usage } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import type { ChatProvider, ChatRequest, ChatTurn } from '../src/provider/ChatProvider.ts';
import {
  BudgetedChatProvider,
  WorkBudget,
  WorkBudgetExhausted,
  type WorkBudgetCause,
  type WorkBudgetConfig,
  type WorkPhase,
  workPhaseForStage,
} from '../src/exec/workBudget.ts';

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  readonly requests: ChatRequest[] = [];
  private readonly handler: ((req: ChatRequest) => Promise<ChatTurn>) | undefined;

  constructor(handler?: (req: ChatRequest) => Promise<ChatTurn>) {
    this.handler = handler;
  }

  chat(req: ChatRequest): Promise<ChatTurn> {
    this.requests.push(req);
    return this.handler?.(req) ?? Promise.resolve(turn());
  }
}

function tempPaths(t: TestContext): WitokPaths {
  const root = mkdtempSync(join(tmpdir(), 'work-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new WitokPaths(root, 'task');
}

function config(overrides: Partial<WorkBudgetConfig> = {}): WorkBudgetConfig {
  return {
    wallClockMs: 10_000,
    requests: 20,
    outputTokens: 1_000,
    reserveWallClockMs: 0,
    reserveRequests: 0,
    reserveOutputTokens: 0,
    ...overrides,
  };
}

function usage(outputTokens = 0, costUsd: number | null = null): Usage {
  return { ...emptyUsage(), outputTokens, costUsd };
}

function turn(outputTokens = 0, costUsd: number | null = null): ChatTurn {
  return { text: 'ok', toolCalls: [], finishReason: 'end_turn', usage: usage(outputTokens, costUsd) };
}

function request(params?: Record<string, unknown>, signal = new AbortController().signal): ChatRequest {
  return {
    model: 'test',
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    signal,
    temperature: null,
    ...(params === undefined ? {} : { params }),
  };
}

async function expectExhausted(
  action: () => Promise<unknown>,
  cause: WorkBudgetCause,
  phase: WorkPhase,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof WorkBudgetExhausted);
    assert.equal(error.cause, cause);
    assert.equal(error.phase, phase);
    assert.match(error.message, /Work budget exhausted/);
    assert.match(error.message, new RegExp(cause));
    return true;
  });
}

test('request reserve is unavailable to work and available to finalization', async t => {
  const budget = new WorkBudget(tempPaths(t), config({ requests: 3, reserveRequests: 1 }));
  const work = new BudgetedChatProvider(new StubProvider(), budget, 'work', 'USD');
  const finalization = new BudgetedChatProvider(new StubProvider(), budget, 'finalization', 'USD');

  await work.chat(request());
  await work.chat(request());
  await expectExhausted(() => work.chat(request()), 'requests', 'work');
  await finalization.chat(request());
  assert.equal(budget.snapshot().requests, 3);

  const stages: StageId[] = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'];
  assert.deepEqual(stages.map(workPhaseForStage), ['work', 'work', 'work', 'work', 'work', 'finalization', 'finalization']);
});

test('output reserve applies to actual usage and finalization can consume it', async t => {
  const budget = new WorkBudget(tempPaths(t), config({ outputTokens: 100, reserveOutputTokens: 40 }));
  const work = new BudgetedChatProvider(new StubProvider(async () => turn(60)), budget, 'work', 'USD');
  const finalization = new BudgetedChatProvider(new StubProvider(async () => turn(40)), budget, 'finalization', 'USD');

  await work.chat(request({ max_tokens: 100 }));
  await expectExhausted(() => work.chat(request()), 'output-tokens', 'work');
  await finalization.chat(request({ max_tokens: 100 }));
  assert.equal(budget.snapshot().outputTokens, 100);
});

test('state restores with the same fingerprint and snapshots are defensive copies', async t => {
  const paths = tempPaths(t);
  const options = config({ cost: { currency: 'USD', amount: 10, reserveAmount: 2 } });
  const budget = new WorkBudget(paths, options, () => 1_000);
  const provider = new BudgetedChatProvider(new StubProvider(async () => turn(7, 1.25)), budget, 'work', 'USD', () => 1_001);
  await provider.chat(request());

  const restored = new WorkBudget(paths, { ...options, cost: { ...options.cost! } }, () => 9_000);
  assert.deepEqual(restored.snapshot(), {
    startedAt: 1_000,
    deadline: 11_000,
    requests: 1,
    outputTokens: 7,
    costByCurrency: { USD: 1.25 },
  });
  const copy = restored.snapshot();
  copy.requests = 99;
  copy.costByCurrency['USD'] = 99;
  assert.equal(restored.snapshot().requests, 1);
  assert.equal(restored.snapshot().costByCurrency['USD'], 1.25);
  assert.throws(() => new WorkBudget(paths, { ...options, requests: 21 }), /fingerprint mismatch/);
});

test('parallel calls reserve requests without an interleaving await', async t => {
  const budget = new WorkBudget(tempPaths(t), config({ requests: 2 }));
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inner = new StubProvider(async () => { await gate; return turn(); });
  const provider = new BudgetedChatProvider(inner, budget, 'work', 'USD');

  const first = provider.chat(request());
  const second = provider.chat(request());
  await expectExhausted(() => provider.chat(request()), 'requests', 'work');
  assert.equal(inner.requests.length, 2);
  assert.equal(budget.snapshot().requests, 2);
  release!();
  await Promise.all([first, second]);
});

test('max_tokens is capped without increase or input mutation', async t => {
  const budget = new WorkBudget(tempPaths(t), config({ outputTokens: 120, reserveOutputTokens: 20 }));
  const inner = new StubProvider(async () => turn(30));
  const provider = new BudgetedChatProvider(inner, budget, 'work', 'USD');
  const params = { max_tokens: 200, top_p: 0.5 };

  await provider.chat(request(params));
  assert.equal(inner.requests[0]!.params!['max_tokens'], 100);
  assert.deepEqual(params, { max_tokens: 200, top_p: 0.5 });

  await provider.chat(request({ max_tokens: 10 }));
  assert.equal(inner.requests[1]!.params!['max_tokens'], 10);
  assert.equal(budget.snapshot().outputTokens, 60);

  await provider.chat(request());
  assert.equal(inner.requests[2]!.params!['max_tokens'], 40);
  assert.equal(budget.snapshot().outputTokens, 90);
});

test('actual output over the phase cap discards the response and is persisted', async t => {
  const paths = tempPaths(t);
  const options = config({ outputTokens: 10 });
  const budget = new WorkBudget(paths, options);
  const provider = new BudgetedChatProvider(new StubProvider(async () => turn(11)), budget, 'work', 'USD');

  await expectExhausted(() => provider.chat(request({ max_tokens: 500 })), 'output-tokens', 'work');
  assert.equal(budget.snapshot().outputTokens, 11);
  assert.equal(new WorkBudget(paths, options).snapshot().outputTokens, 11);
});

test('cost is capped only in the configured currency and null is not recorded', async t => {
  const budget = new WorkBudget(tempPaths(t), config({
    cost: { currency: 'USD', amount: 1, reserveAmount: 0.25 },
  }));
  const euro = new BudgetedChatProvider(new StubProvider(async () => turn(0, 5)), budget, 'work', 'EUR');
  const local = new BudgetedChatProvider(new StubProvider(async () => turn(0, null)), budget, 'work', 'USD');
  const dollars = new BudgetedChatProvider(new StubProvider(async () => turn(0, 0.5)), budget, 'work', 'USD');

  await euro.chat(request());
  await local.chat(request());
  assert.deepEqual(budget.snapshot().costByCurrency, { EUR: 5 });
  await dollars.chat(request());
  assert.deepEqual(budget.snapshot().costByCurrency, { EUR: 5, USD: 0.5 });

  const over = new BudgetedChatProvider(new StubProvider(async () => turn(0, 0.3)), budget, 'work', 'USD');
  await expectExhausted(() => over.chat(request()), 'cost', 'work');
  assert.equal(budget.snapshot().costByCurrency['USD'], 0.8);

  const finalization = new BudgetedChatProvider(new StubProvider(async () => turn(0, 0.2)), budget, 'finalization', 'USD');
  await finalization.chat(request());
  assert.equal(budget.snapshot().costByCurrency['USD'], 1);
});

test('wall-clock reserve has one absolute deadline across restored phases', async t => {
  const paths = tempPaths(t);
  let now = 0;
  const options = config({ wallClockMs: 100, reserveWallClockMs: 20 });
  const budget = new WorkBudget(paths, options, () => now);
  const work = new BudgetedChatProvider(new StubProvider(), budget, 'work', 'USD', () => now);
  const finalization = new BudgetedChatProvider(new StubProvider(), budget, 'finalization', 'USD', () => now);

  now = 80;
  await expectExhausted(() => work.chat(request()), 'wall-clock', 'work');
  await finalization.chat(request());
  const restored = new WorkBudget(paths, options, () => now);
  const restoredFinalization = new BudgetedChatProvider(new StubProvider(), restored, 'finalization', 'USD', () => now);
  now = 100;
  await expectExhausted(() => restoredFinalization.chat(request()), 'wall-clock', 'finalization');
  assert.equal(restored.snapshot().deadline, 100);
});

test('budget abort is typed and does not abort or rename operator cancellation', async t => {
  const waitForAbort = async (req: ChatRequest): Promise<ChatTurn> => new Promise<ChatTurn>((_resolve, reject) => {
    if (req.signal.aborted) reject(req.signal.reason);
    else req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
  });

  // Keep synchronous setup/I/O outside the time-under-test. The real 40ms
  // request timer still fires, regardless of machine load before dispatch.
  const now = () => 0;
  const budget = new WorkBudget(tempPaths(t), config({ wallClockMs: 40 }), now);
  const inner = new StubProvider(waitForAbort);
  const provider = new BudgetedChatProvider(inner, budget, 'work', 'USD', now);
  const operator = new AbortController();
  await expectExhausted(() => provider.chat(request(undefined, operator.signal)), 'wall-clock', 'work');
  assert.equal(operator.signal.aborted, false);
  assert.equal(inner.requests[0]!.signal === operator.signal, false);

  const secondBudget = new WorkBudget(tempPaths(t), config({ wallClockMs: 1_000 }));
  const second = new BudgetedChatProvider(new StubProvider(waitForAbort), secondBudget, 'work', 'USD');
  const secondOperator = new AbortController();
  const reason = new Error('operator stop');
  const pending = second.chat(request(undefined, secondOperator.signal));
  secondOperator.abort(reason);
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error, reason);
    assert.equal(error instanceof WorkBudgetExhausted, false);
    return true;
  });
});

test('configuration limits and reserves are validated', t => {
  const paths = tempPaths(t);
  assert.throws(() => new WorkBudget(paths, config({ requests: 0 })), /positive integer/);
  assert.throws(() => new WorkBudget(paths, config({ outputTokens: 1.5 })), /positive integer/);
  assert.throws(() => new WorkBudget(paths, config({ reserveRequests: -1 })), /non-negative integer/);
  assert.throws(() => new WorkBudget(paths, config({ reserveWallClockMs: 10_001 })), /no greater/);
  assert.throws(() => new WorkBudget(paths, config({
    cost: { currency: 'USD', amount: 1, reserveAmount: 2 },
  })), /reserveAmount/);
});
