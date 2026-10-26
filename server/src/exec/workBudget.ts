import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StageId, Usage } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';
import { atomicJson } from '../fs/atomicJson.ts';
import type { ChatProvider, ChatRequest } from '../provider/ChatProvider.ts';

export type WorkPhase = 'work' | 'finalization';
export type WorkBudgetCause = 'wall-clock' | 'requests' | 'output-tokens' | 'cost';

export interface WorkBudgetConfig {
  wallClockMs: number;
  requests: number;
  outputTokens: number;
  reserveWallClockMs: number;
  reserveRequests: number;
  reserveOutputTokens: number;
  cost?: { currency: string; amount: number; reserveAmount: number };
}

export interface WorkBudgetSnapshot {
  startedAt: number;
  deadline: number;
  requests: number;
  outputTokens: number;
  costByCurrency: Record<string, number>;
}

interface PersistedWorkBudget extends WorkBudgetSnapshot {
  version: 1;
  configFingerprint: string;
}

export class WorkBudgetExhausted extends Error {
  override readonly cause: WorkBudgetCause;
  readonly phase: WorkPhase;

  constructor(cause: WorkBudgetCause, phase: WorkPhase, detail: string) {
    super(`Work budget exhausted during ${phase}: ${cause}; ${detail}`);
    this.name = 'WorkBudgetExhausted';
    this.cause = cause;
    this.phase = phase;
  }
}

export class WorkBudget {
  private readonly path: string;
  private readonly config: WorkBudgetConfig;
  private readonly fingerprint: string;
  private state: WorkBudgetSnapshot;

  constructor(paths: WitokPaths, config: WorkBudgetConfig, now: () => number = Date.now) {
    validateConfig(config);
    this.path = join(paths.runnerDir, 'work-budget.json');
    this.config = copyConfig(config);
    this.fingerprint = fingerprintOf(this.config);

    let restored: PersistedWorkBudget | undefined;
    try {
      restored = JSON.parse(readFileSync(this.path, 'utf8')) as PersistedWorkBudget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (restored === undefined) {
      const startedAt = now();
      this.state = { startedAt, deadline: startedAt + config.wallClockMs, requests: 0, outputTokens: 0, costByCurrency: {} };
      this.persist();
    } else {
      if (restored.version !== 1 || restored.configFingerprint !== this.fingerprint) {
        throw new Error('Work budget configuration fingerprint mismatch; refusing to restore saved state');
      }
      assertPersistedState(restored);
      this.state = {
        startedAt: restored.startedAt,
        deadline: restored.deadline,
        requests: restored.requests,
        outputTokens: restored.outputTokens,
        costByCurrency: { ...restored.costByCurrency },
      };
    }
  }

  snapshot(): WorkBudgetSnapshot {
    return { ...this.state, costByCurrency: { ...this.state.costByCurrency } };
  }

  phaseDeadline(phase: WorkPhase): number {
    return phase === 'work' ? this.state.deadline - this.config.reserveWallClockMs : this.state.deadline;
  }

  remainingOutput(phase: WorkPhase): number {
    return this.cap('outputTokens', phase) - this.state.outputTokens;
  }

  beginRequest(phase: WorkPhase, currency: string, at: number): void {
    this.checkWallClock(phase, at);
    const requestCap = this.cap('requests', phase);
    if (this.state.requests >= requestCap) {
      throw new WorkBudgetExhausted('requests', phase, `${this.state.requests} of ${requestCap} requests used`);
    }
    this.checkOutput(phase);
    this.checkCost(phase, currency);
    this.state.requests++;
    this.persist();
  }

  recordUsage(phase: WorkPhase, currency: string, usage: Usage): void {
    if (!Number.isFinite(usage.outputTokens) || usage.outputTokens < 0) {
      throw new Error('Chat response contains invalid output token usage');
    }
    if (usage.costUsd !== null && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
      throw new Error('Chat response contains invalid cost usage');
    }
    this.state.outputTokens += usage.outputTokens;
    if (usage.costUsd !== null) {
      this.state.costByCurrency[currency] = (this.state.costByCurrency[currency] ?? 0) + usage.costUsd;
    }
    this.persist();
    this.checkOutput(phase, false);
    this.checkCost(phase, currency, false);
  }

  private cap(kind: 'requests' | 'outputTokens' | 'cost', phase: WorkPhase): number {
    if (kind === 'requests') return this.config.requests - (phase === 'work' ? this.config.reserveRequests : 0);
    if (kind === 'outputTokens') return this.config.outputTokens - (phase === 'work' ? this.config.reserveOutputTokens : 0);
    if (this.config.cost === undefined) return Infinity;
    return this.config.cost.amount - (phase === 'work' ? this.config.cost.reserveAmount : 0);
  }

  private checkWallClock(phase: WorkPhase, at: number): void {
    const deadline = this.phaseDeadline(phase);
    if (at >= deadline) {
      throw new WorkBudgetExhausted('wall-clock', phase, `deadline ${deadline} reached at ${at}`);
    }
  }

  private checkOutput(phase: WorkPhase, preCall = true): void {
    const cap = this.cap('outputTokens', phase);
    if (preCall ? this.state.outputTokens >= cap : this.state.outputTokens > cap) {
      throw new WorkBudgetExhausted('output-tokens', phase, `${this.state.outputTokens} of ${cap} output tokens used`);
    }
  }

  private checkCost(phase: WorkPhase, currency: string, preCall = true): void {
    const configured = this.config.cost;
    if (configured === undefined || configured.currency !== currency) return;
    const cap = this.cap('cost', phase);
    const spent = this.state.costByCurrency[currency] ?? 0;
    if (preCall ? spent >= cap : spent > cap) {
      throw new WorkBudgetExhausted('cost', phase, `${spent} of ${cap} ${currency} used`);
    }
  }

  private persist(): void {
    const value: PersistedWorkBudget = { version: 1, configFingerprint: this.fingerprint, ...this.state };
    atomicJson(this.path, value);
  }
}

export class BudgetedChatProvider implements ChatProvider {
  readonly name: string;
  private readonly inner: ChatProvider;
  private readonly budget: WorkBudget;
  private readonly phase: WorkPhase;
  private readonly currency: string;
  private readonly now: () => number;

  constructor(inner: ChatProvider, budget: WorkBudget, phase: WorkPhase, currency: string, now: () => number = Date.now) {
    this.inner = inner;
    this.budget = budget;
    this.phase = phase;
    this.currency = currency;
    this.now = now;
    this.name = inner.name;
  }

  async chat(req: ChatRequest): ReturnType<ChatProvider['chat']> {
    this.budget.beginRequest(this.phase, this.currency, this.now());
    const remainingOutput = this.budget.remainingOutput(this.phase);

    const configuredOutput = req.params?.['max_tokens'];
    const request: ChatRequest = { ...req, params: { ...(req.params ?? {}),
      max_tokens: Math.min(typeof configuredOutput === 'number' ? configuredOutput : remainingOutput, remainingOutput) } };

    const budgetController = new AbortController();
    const signal = AbortSignal.any([req.signal, budgetController.signal]);
    const deadline = this.budget.phaseDeadline(this.phase);
    const timer = setTimeout(() => budgetController.abort(), Math.max(1, deadline - this.now()));
    timer.unref();

    try {
      const response = await this.inner.chat({ ...request, signal });
      this.budget.recordUsage(this.phase, this.currency, response.usage);
      if (budgetController.signal.aborted || this.now() >= deadline) {
        throw new WorkBudgetExhausted('wall-clock', this.phase, `deadline ${deadline} reached during model request`);
      }
      return response;
    } catch (error) {
      if (budgetController.signal.aborted && !req.signal.aborted) {
        throw new WorkBudgetExhausted('wall-clock', this.phase, `deadline ${deadline} reached during model request`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function workPhaseForStage(stage: StageId): WorkPhase {
  return stage === 'verify' || stage === 'handoff' ? 'finalization' : 'work';
}

function copyConfig(config: WorkBudgetConfig): WorkBudgetConfig {
  return { ...config, ...(config.cost === undefined ? {} : { cost: { ...config.cost } }) };
}

function fingerprintOf(config: WorkBudgetConfig): string {
  const canonical = {
    wallClockMs: config.wallClockMs,
    requests: config.requests,
    outputTokens: config.outputTokens,
    reserveWallClockMs: config.reserveWallClockMs,
    reserveRequests: config.reserveRequests,
    reserveOutputTokens: config.reserveOutputTokens,
    cost: config.cost === undefined ? null : {
      currency: config.cost.currency,
      amount: config.cost.amount,
      reserveAmount: config.cost.reserveAmount,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateConfig(config: WorkBudgetConfig): void {
  positiveInteger(config.wallClockMs, 'wallClockMs');
  positiveInteger(config.requests, 'requests');
  positiveInteger(config.outputTokens, 'outputTokens');
  reserve(config.reserveWallClockMs, config.wallClockMs, 'reserveWallClockMs');
  reserve(config.reserveRequests, config.requests, 'reserveRequests');
  reserve(config.reserveOutputTokens, config.outputTokens, 'reserveOutputTokens');
  if (config.cost !== undefined) {
    if (config.cost.currency.trim() === '') throw new Error('Work budget cost currency must not be empty');
    if (!Number.isFinite(config.cost.amount) || config.cost.amount <= 0) throw new Error('Work budget cost amount must be positive');
    if (!Number.isFinite(config.cost.reserveAmount) || config.cost.reserveAmount < 0 || config.cost.reserveAmount > config.cost.amount) {
      throw new Error('Work budget cost reserveAmount must be between zero and amount');
    }
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Work budget ${name} must be a positive integer`);
}

function reserve(value: number, total: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > total) {
    throw new Error(`Work budget ${name} must be a non-negative integer no greater than its limit`);
  }
}

function assertPersistedState(value: PersistedWorkBudget): void {
  if (!Number.isFinite(value.startedAt) || !Number.isFinite(value.deadline) ||
      !Number.isInteger(value.requests) || value.requests < 0 ||
      !Number.isFinite(value.outputTokens) || value.outputTokens < 0 ||
      value.costByCurrency === null || typeof value.costByCurrency !== 'object' || Array.isArray(value.costByCurrency)) {
    throw new Error('Saved work budget state is invalid');
  }
  for (const [currency, amount] of Object.entries(value.costByCurrency)) {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Saved work budget cost for ${currency} is invalid`);
  }
}
