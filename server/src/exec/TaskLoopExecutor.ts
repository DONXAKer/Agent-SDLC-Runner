import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Decision, NormalizedCall, PreparedPrompt, Question, ToolName, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';
import { evaluate } from '../policy/index.ts';
import { foldPathCase, relativizeWithin, resolveUserPath } from '../policy/paths.ts';
import { symlinkEscape } from '../approval/symlink.ts';
import { destructiveOverwrite } from '../approval/destructive.ts';
import { ProviderEnvError } from '../provider/ChatProvider.ts';
import { LoopExecutor, type LoopOptions } from './LoopExecutor.ts';
import { ExecutionObserver } from './executionObserver.ts';
import type { ExecHooks, StageResult } from './StageExecutor.ts';
import { requirementEvidence, validateRequirements, type TaskRequirement } from './taskEvidence.ts';
import { askHumanRuntimeReply, matchesExecutableTestShape } from './taskLoopAsk.ts';

/** Pilot contract comes from the human, never from the model's proposed plan. */
export interface TaskLoopContract {
  task: string;
  /** Exact relative paths, or directory prefixes ending in '/'. */
  writable: readonly string[];
  protected: readonly string[];
  allowDestructiveOverwrite?: boolean;
  requirements?: readonly TaskRequirement[];
  /**
   * When set, finish requires at least one new non-protected file under these prefixes
   * (typically test/). Prevents ready_for_review without the human's new-test obligation.
   */
  requireAdditionalTestsUnder?: readonly string[];
}
export interface TaskCheckResult { passed: boolean; output: string; environmentError?: string }
export interface TaskCheck {
  name: string;
  /** New behavior need not pass before implementation; existing regression checks do. */
  baseline?: boolean;
  /** Registered by the caller; model arguments cannot supply a command or cwd. */
  run(signal: AbortSignal): Promise<TaskCheckResult>;
}
export type TaskLoopStatus = 'ready_for_review' | 'needs_input' | 'failed' | 'budget_exhausted' | 'environment_error';
export interface TaskLoopEvent { version: 1; at: string; elapsedMs: number; kind: string; payload: unknown }
export interface TaskLoopResult {
  version: 1;
  status: TaskLoopStatus;
  reason: string;
  finalText: string;
  usage: Usage;
  currency: string;
  checks: { name: string; baseline: boolean; revision: string; passed: boolean; output: string }[];
  questions: Question[];
  requirements: ReturnType<typeof requirementEvidence>;
  metrics: {
    modelRequests: number; writes: number; denied: number; repairs: number; repeatedErrors: number;
    repeatedCheckFailures: number;
    firstEditMs: number | null; firstCheckMs: number | null; humanWaitMs: number; activeMs: number;
    telemetryErrors: number;
  };
}
export interface TaskLoopRequest {
  cwd: string;
  model: string;
  contract: TaskLoopContract;
  checks: readonly TaskCheck[];
  maxTurns: number;
  activeTimeoutMs: number;
  maxCost: number | null;
  /** Optional experimental feedback format; raw check output remains available in both modes. */
  structuredFeedback?: boolean;
  maxUnchangedFailures?: number;
  /** Stop after this many identical tool-error summaries (second and later repeats). */
  maxRepeatedErrors?: number;
  signal: AbortSignal;
  ask(questions: readonly Question[], signal: AbortSignal): Promise<Record<string, string[]>>;
  emit?(event: TaskLoopEvent): void;
}

/** Model-facing hint when the same tool failure keeps repeating (measured repair→pathology class). */
const REPEATED_STRATEGY_HINT =
  'Same failure pattern is repeating. Change strategy: prefer the simplest correct algorithm for the failing assertion; do not elaborate speculative precision, bit-width tricks, or unbounded refinement loops.';
const LATENCY_HINT =
  'Check exceeded the latency budget relative to baseline. Simplify the algorithm; remove unbounded refinement loops and speculative precision workarounds.';

/** Floor and multiplier for post-baseline check duration vs the green baseline run of the same check. */
export const CHECK_LATENCY_FLOOR_MS = 2000;
export const CHECK_LATENCY_MULTIPLIER = 5;
/** Extra chat attempts after OpenAI-compat's own 5xx retries — intermittent Ollama JSON/500 faults. */
export const PROVIDER_ENV_RETRIES = 2;
export const PROVIDER_ENV_RETRY_DELAY_MS = 400;

/** Stable fingerprint of failing check output for repeated-failure detection (not tool-summary). */
export function failingCheckFingerprint(name: string, output: string): string {
  const lines = output.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/iu.test(line))
    .filter(line => /^(not ok\b|AssertionError\b|Error:|expected\b|actual\b)/iu.test(line) || line.includes('FAIL') || line.includes('timed out'))
    .slice(0, 8);
  return `${name}\n${lines.join('\n') || output.trim().slice(0, 400)}`;
}

const TOOLS: readonly ToolName[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'McpRead'];
const PRIVATE = ['.git/', '.runner/', '.sdlc/', 'node_modules/'];
const normalizePath = (path: string): string => foldPathCase(path.replaceAll('\\', '/'));
export function inTaskPaths(path: string, entries: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return entries.some(entry => {
    const p = normalizePath(entry);
    return p.endsWith('/') ? normalized === p.slice(0, -1) || normalized.startsWith(p) : normalized === p;
  });
}

/** Relative files under prefixes, skipping private roots and optionally protected paths. */
export function listTaskFiles(root: string, prefixes: readonly string[], protectedPaths: readonly string[] = []): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix + name;
      if (inTaskPaths(relative, PRIVATE) || inTaskPaths(relative, protectedPaths)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Unsupported symbolic link: ${relative}`);
      if (stat.isDirectory()) visit(path, relative + '/');
      else if (stat.isFile()) {
        if (prefixes.length === 0 || inTaskPaths(relative, prefixes)) out.push(normalizePath(relative));
      } else throw new Error(`Unsupported file type: ${relative}`);
    }
  };
  visit(root, '');
  return out;
}

/** Includes untracked files. Reject links: search tools must not traverse a different tree. */
export function taskRevision(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix + name;
      if (inTaskPaths(relative, PRIVATE)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Unsupported symbolic link: ${relative}`);
      if (stat.isDirectory()) visit(path, relative + '/');
      else if (stat.isFile()) hash.update(relative).update('\0').update(readFileSync(path)).update('\0');
      else throw new Error(`Unsupported file type: ${relative}`);
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

/** One coherent tool history, using exactly the same loop for local and API routes. */
export class TaskLoopExecutor {
  private readonly options: LoopOptions;
  constructor(options: LoopOptions) { this.options = options; }

  async run(req: TaskLoopRequest): Promise<TaskLoopResult> {
    if (!Number.isFinite(req.activeTimeoutMs) || req.activeTimeoutMs <= 0 || !Number.isInteger(req.maxTurns) || req.maxTurns < 1)
      throw new Error('Positive active timeout and turn limit required');
    if (req.maxCost !== null && (!Number.isFinite(req.maxCost) || req.maxCost <= 0)) throw new Error('Positive cost cap required');
    if (!req.checks.length || new Set(req.checks.map(c => c.name)).size !== req.checks.length) throw new Error('Unique registered checks required');
    if (!req.checks.some(c => c.baseline !== false)) throw new Error('At least one baseline regression check required');
    validateRequirements(req.contract.requirements ?? [], req.checks.map(c => c.name));
    if (req.maxUnchangedFailures !== undefined && (!Number.isInteger(req.maxUnchangedFailures) || req.maxUnchangedFailures < 2)) throw new Error('Unchanged failure limit must be an integer >= 2');
    if (req.maxRepeatedErrors !== undefined && (!Number.isInteger(req.maxRepeatedErrors) || req.maxRepeatedErrors < 2)) throw new Error('Repeated error limit must be an integer >= 2');
    for (const path of [...req.contract.writable, ...req.contract.protected, ...(req.contract.requireAdditionalTestsUnder ?? [])]) {
      if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').includes('..') || path.includes('*'))
        throw new Error(`Contract paths must be relative exact paths or directory prefixes: ${path}`);
    }
    if ((req.contract.requireAdditionalTestsUnder ?? []).some(path => !inTaskPaths(path.endsWith('/') ? `${path}file` : path, req.contract.writable)))
      throw new Error('requireAdditionalTestsUnder entries must lie inside writable boundaries');
    const started = performance.now();
    const controller = new AbortController();
    let stop: TaskLoopStatus | null = null;
    let reason = '';
    let remaining = req.activeTimeoutMs;
    let resumedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const metrics: TaskLoopResult['metrics'] = { modelRequests: 0, writes: 0, denied: 0, repairs: 0, repeatedErrors: 0,
      repeatedCheckFailures: 0, firstEditMs: null, firstCheckMs: null, humanWaitMs: 0, activeMs: 0, telemetryErrors: 0 };
    const emit = (kind: string, payload: unknown): void => {
      try { req.emit?.({ version: 1, at: new Date().toISOString(), elapsedMs: performance.now() - started, kind, payload }); }
      catch { metrics.telemetryErrors++; }
    };
    const halt = (status: TaskLoopStatus, note: string): void => {
      if (stop !== null) return;
      stop = status; reason = note; controller.abort(new Error(note));
      emit('stop', { status, reason });
    };
    const pause = (): void => { clearTimeout(timer); remaining -= performance.now() - resumedAt; };
    const resume = (): void => {
      resumedAt = performance.now();
      if (remaining <= 0) halt('budget_exhausted', 'Active deadline exhausted');
      else timer = setTimeout(() => halt('budget_exhausted', 'Active deadline exhausted'), remaining);
    };
    const cancel = (): void => halt('failed', 'Cancelled by operator');
    req.signal.addEventListener('abort', cancel, { once: true });
    if (req.signal.aborted) cancel();
    resume();
    const observer = new ExecutionObserver(event => emit('execution', event), controller.signal);
    const end = observer.start('item', { task: req.contract.task, contract: req.contract });
    const checks: TaskLoopResult['checks'] = [];
    const questions: Question[] = [];
    const fresh = new Map<string, string>();
    const pending = new Map<string, { call: NormalizedCall; before: string | null }>();
    const errors = new Set<string>();
    const checkFingerprints = new Set<string>();
    const baselineMs = new Map<string, number>();
    const checkDurationsMs: Record<string, number> = {};
    let progress = 0;
    let failedCheck = false;
    let latencyBudgetExceeded = false;
    let usage = emptyUsage();
    let result: StageResult | undefined;
    let lastFailure: string | null = null;
    let unchangedFailures = 0;

    const runCheck = async (registered: TaskCheck): Promise<TaskCheckResult & { durationMs: number }> => {
      const timeout = AbortSignal.timeout(this.options.bashTimeoutMs);
      const signal = AbortSignal.any([controller.signal, timeout]);
      const t0 = performance.now();
      try {
        const outcome = await registered.run(signal);
        const durationMs = performance.now() - t0;
        if (timeout.aborted && !controller.signal.aborted)
          return { passed: false, output: `${outcome.output}\nCheck timed out after ${this.options.bashTimeoutMs} ms`, durationMs };
        return { ...outcome, durationMs };
      } catch (error) {
        const durationMs = performance.now() - t0;
        if (timeout.aborted && !controller.signal.aborted)
          return { passed: false, output: `Check timed out after ${this.options.bashTimeoutMs} ms`, durationMs };
        return { passed: false, output: String(error), environmentError: String(error), durationMs };
      }
    };
    const check = async (baseline: boolean): Promise<{ ok: boolean; text: string }> => {
      const output: string[] = [];
      let passed = true;
      latencyBudgetExceeded = false;
      const roundDurations: Record<string, number> = {};
      for (const registered of req.checks) {
        if (baseline && registered.baseline === false) continue;
        if (controller.signal.aborted) return { ok: false, text: reason };
        const revision = taskRevision(req.cwd);
        const finish = observer.start('check', { name: registered.name, baseline, revision });
        if (!baseline) metrics.firstCheckMs ??= performance.now() - started;
        let outcome = await runCheck(registered);
        roundDurations[registered.name] = outcome.durationMs;
        checkDurationsMs[registered.name] = outcome.durationMs;
        if (baseline && outcome.passed) baselineMs.set(registered.name, outcome.durationMs);
        if (!baseline) {
          const base = baselineMs.get(registered.name);
          if (base !== undefined && outcome.passed) {
            const budget = Math.max(CHECK_LATENCY_FLOOR_MS, base * CHECK_LATENCY_MULTIPLIER);
            if (outcome.durationMs > budget) {
              latencyBudgetExceeded = true;
              outcome = {
                passed: false,
                output: `${outcome.output}\nLatency budget exceeded: ${Math.round(outcome.durationMs)} ms > ${Math.round(budget)} ms (baseline ${Math.round(base)} ms). ${LATENCY_HINT}`,
                durationMs: outcome.durationMs,
              };
            }
          }
        }
        const current = taskRevision(req.cwd);
        const valid = outcome.passed && current === revision && !controller.signal.aborted;
        finish(controller.signal.aborted ? 'interrupted' : valid ? 'passed' : 'failed', outcome);
        checks.push({ name: registered.name, baseline, revision, passed: valid, output: outcome.output });
        output.push(`${registered.name}: ${valid ? 'PASS' : 'FAIL'}\n${outcome.output}${current !== revision ? '\nFiles changed during check; evidence is stale.' : ''}`);
        if (!baseline && !valid) {
          const fp = failingCheckFingerprint(registered.name, outcome.output);
          if (checkFingerprints.has(fp)) metrics.repeatedCheckFailures++;
          checkFingerprints.add(fp);
        }
        if (!baseline && valid) { if (fresh.get(registered.name) !== revision) progress++; fresh.set(registered.name, revision); }
        else fresh.delete(registered.name);
        passed &&= valid;
        if (outcome.environmentError) halt('environment_error', outcome.environmentError);
      }
      if (!baseline && !passed) {
        failedCheck = true;
        if (metrics.repeatedErrors >= 3 || metrics.repeatedCheckFailures >= 3) output.push(REPEATED_STRATEGY_HINT);
        if (latencyBudgetExceeded) output.push(LATENCY_HINT);
      }
      if (!baseline) {
        const revision = taskRevision(req.cwd);
        const requirements = requirementEvidence(req.contract.requirements ?? [], checks, revision);
        emit('requirement_evidence', { requirements, checkDurationsMs: roundDurations, latencyBudgetExceeded });
        if (req.structuredFeedback) {
          const stuck = metrics.repeatedErrors >= 3 || metrics.repeatedCheckFailures >= 3;
          const nextAction = passed
            ? 'Review remaining unverified requirements before finishing.'
            : latencyBudgetExceeded
              ? `${LATENCY_HINT} Then run checks again.`
              : stuck
                ? `${REPEATED_STRATEGY_HINT} Then run checks again. Raw assertion output above contains available expected/actual values.`
                : 'Repair the reported failure with the simplest correct algorithm, then run checks again. Raw assertion output above contains available expected/actual values.';
          output.push(JSON.stringify({ revision, requirements, nextAction, checkDurationsMs: roundDurations, latencyBudgetExceeded }));
        }
        const failure = JSON.stringify({ revision, output: output.filter(line => !line.startsWith('{')) });
        unchangedFailures = !passed && lastFailure === failure ? unchangedFailures + 1 : !passed ? 1 : 0;
        lastFailure = passed ? null : failure;
        if (req.maxUnchangedFailures !== undefined && unchangedFailures >= req.maxUnchangedFailures)
          halt('failed', 'Repeated identical failed checks on unchanged files; no repair progress');
      }
      return { ok: passed, text: output.join('\n\n') };
    };
    const testPrefixes = req.contract.requireAdditionalTestsUnder ?? [];
    const initialTestFiles = new Set(testPrefixes.length === 0 ? [] : listTaskFiles(req.cwd, testPrefixes, req.contract.protected));
    // Include protected seeds so extension/.test. shape matches the fixture suite the runner actually executes.
    const seedTestFiles = testPrefixes.length === 0 ? [] : listTaskFiles(req.cwd, testPrefixes, []);
    const finishGuard = (): string | null => {
      if (stop !== null) return reason;
      const revision = taskRevision(req.cwd);
      const missing = req.checks.filter(c => fresh.get(c.name) !== revision).map(c => c.name);
      if (missing.length) return `Run mcp__task__check after the last edit. Current passing evidence missing: ${missing.join(', ')}. Repair failures before finishing.`;
      if (testPrefixes.length > 0) {
        const added = listTaskFiles(req.cwd, testPrefixes, req.contract.protected)
          .filter(path => !initialTestFiles.has(path) && matchesExecutableTestShape(path, seedTestFiles));
        if (added.length === 0) {
          return `Add at least one new executable test file under ${testPrefixes.join(', ')} matching the existing suite shape (same extension` +
            `${seedTestFiles.some(f => /\.(test|spec)\./u.test(f)) ? ' and .test./.spec. name' : ''}; existing protected tests do not count), then run mcp__task__check before finishing.`;
        }
      }
      return null;
    };
    const deny = (why: string): Decision => { metrics.denied++; return { allowed: false, reason: why, by: 'policy' }; };
    const hooks: ExecHooks = {
      onText: text => emit('text', { text }), onThinking: text => emit('thinking', { text }),
      onWarn: text => emit('warning', { text }), onFriction: kind => emit('friction', { kind }),
      onHarnessEvent: event => emit('harness', event), onExecution: event => emit('execution', event),
      onUsage: (value, durationMs) => { usage = addUsage(usage, value); emit('model_work', { usage: value, durationMs, purpose: 'implementation', currency: this.options.currency ?? 'USD' }); },
      onRecord: () => { throw new Error('Document recording is not available in task loop'); },
      onToolRequest: async (call, meta) => {
        let decision: Decision = { allowed: true, updatedInput: null, by: 'policy' };
        const path = 'path' in call && typeof call.path === 'string' ? call.path : null;
        const relative = path === null ? null : relativizeWithin(req.cwd, resolveUserPath(req.cwd, path));
        const writing = call.kind === 'write' || call.kind === 'edit';
        if (controller.signal.aborted) decision = deny(reason);
        else if (relative !== null && (inTaskPaths(relative, PRIVATE) || relative.split('/').some(part => /[:\x00-\x1f]/u.test(part) || /[. ]$/u.test(part)))) decision = deny('Runtime/dependency metadata or ambiguous filesystem path is not accessible');
        else if (writing && (relative === null || !inTaskPaths(relative, req.contract.writable) || inTaskPaths(relative, req.contract.protected)))
          decision = deny('Write is outside human contract or targets a protected file.');
        else {
          const verdict = evaluate(call, { projectRoot: req.cwd, stage: 'chunk', sdlcDir: '.sdlc/task-loop',
            // Policy still enforces tool/path/deny-list guards. Authority comes ONLY from the human contract above.
            planFiles: writing && relative !== null ? [relative] : [], protectedArtifacts: [...req.contract.protected],
            readOnlyRoots: [], allowedTools: TOOLS,
            mcpTools: [{ server: 'task', tool: 'check', mode: 'read', pathArgs: [] }] });
          if (!verdict.ok) decision = deny(verdict.reason);
          else if (path !== null && symlinkEscape(req.cwd, path, []) !== null) decision = deny('Symbolic link escapes workspace');
          else if (writing && !req.contract.allowDestructiveOverwrite && destructiveOverwrite(call, req.cwd) !== null)
            decision = deny('Destructive overwrite denied; use a focused Edit preserving unrelated content');
        }
        pending.set(meta.requestId, { call, before: writing && decision.allowed ? taskRevision(req.cwd) : null });
        emit('tool_request', { ...meta, call, decision });
        return decision;
      },
      onToolResult: meta => {
        const before = pending.get(meta.requestId);
        pending.delete(meta.requestId);
        if (before?.before !== null && before?.before !== undefined && before.before !== taskRevision(req.cwd)) {
          // Write/Edit may save a file before returning an import diagnostic. Count the disk change.
          metrics.writes++; metrics.firstEditMs ??= performance.now() - started;
          if (meta.ok) {
            progress++; fresh.clear();
            if (failedCheck) { metrics.repairs++; failedCheck = false; }
          }
          // Failed writes already invalidate evidence through finishGuard's revision comparison.
          emit('implementation_write', { requestId: meta.requestId, toolOk: meta.ok });
        }
        if (!meta.ok) {
          if (errors.has(meta.summary)) {
            metrics.repeatedErrors++;
            if (req.maxRepeatedErrors !== undefined && metrics.repeatedErrors >= req.maxRepeatedErrors)
              halt('failed', 'Repeated identical tool errors without a new strategy; simplify the approach');
          }
          errors.add(meta.summary);
        }
        emit('tool_result', meta);
      },
      onAskHuman: async call => {
        if (call.kind !== 'ask_human') return {};
        questions.push(...call.questions);
        const runtimeReply = askHumanRuntimeReply(call.questions, req.contract.writable, req.contract.task);
        if (runtimeReply !== null) {
          // Scope / harness / technique / contract-restatement / meta-review — answer in-loop
          // so an empty bank does not stop the run with needs_input (measured: examples/, mellum range/csv).
          const answers = Object.fromEntries(call.questions.map(q => [q.id, [runtimeReply]]));
          emit('human_request', call);
          emit('warning', { text: runtimeReply });
          emit('human_answer', { answers, source: 'runtime' });
          lastFailure = null; unchangedFailures = 0;
          return answers;
        }
        // After green registered checks, do not consult the bank: empty fallback would poison
        // pilot obligations.questions while ready_for_review is otherwise correct.
        if (finishGuard() === null) {
          const ignored = 'Registered checks already have fresh passing evidence. Put remaining notes in your final summary; do not AskHuman for meta-review.';
          const answers = Object.fromEntries(call.questions.map(q => [q.id, [ignored]]));
          emit('human_request', call);
          emit('warning', { text: 'Unanswered AskHuman ignored: registered checks already have fresh passing evidence; finish instead of blocking on speculation outside the contract.' });
          emit('human_answer', { answers, source: 'ignored_after_green' });
          lastFailure = null; unchangedFailures = 0;
          return answers;
        }
        pause();
        const waitStarted = performance.now();
        emit('human_request', call);
        let abortWait: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            abortWait = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', abortWait, { once: true });
            if (controller.signal.aborted) abortWait();
          });
          const answers = await Promise.race([req.ask(call.questions, controller.signal), aborted]);
          lastFailure = null; unchangedFailures = 0;
          emit('human_answer', { answers });
          const unanswered = call.questions.some(q => !answers[q.id]?.some(answer => answer.trim().length > 0));
          if (unanswered) {
            halt('needs_input', 'Human information is required; at least one question has no answer');
          }
          return answers;
        } finally {
          if (abortWait) controller.signal.removeEventListener('abort', abortWait);
          metrics.humanWaitMs += performance.now() - waitStarted; resume();
        }
      },
    };
    try {
      taskRevision(req.cwd);
      const baseline = await check(true);
      emit('baseline', baseline);
      if (!baseline.ok && stop === null) halt('environment_error', 'Visible baseline checks failed; this pilot requires a green baseline');
      if (stop === null) {
        const prompt: PreparedPrompt = {
          presetNote: null, tools: [], editedByOperator: false, system: [
            'Work on the human task within the supplied boundaries. Read relevant code, implement, run checks, repair, then summarize evidence and remaining limitations.',
            'Use one continuous investigation and implementation loop. No process documents or mandatory plan artifacts are required.',
            'Use AskHuman only for missing business facts, contradictions, or a required scope change. Never invent missing facts. A question does not grant a scope expansion.',
            'Do not AskHuman about error-type preferences, harness internals, creating directories outside writable prefixes, reconfirming behavior already written in the task, or meta-review (satisfy requirements / scope / limitations) — implement under the contract and finish.',
            'Registered check names label verification categories; they are not filesystem paths to create.',
            'Use mcp__task__check to run all registered visible checks. Shell commands are unavailable. Checks must pass after your final edit.',
            'Passing visible checks establishes readiness for review, not proof of all requirements. Compare the patch against every requirement before finishing.',
            'Prefer the simplest implementation that satisfies failing checks. Do not replace working integer arithmetic with speculative precision, bit-width tricks, or unbounded refinement loops.',
            'When a check fails because an own property is missing (for example key "__proto__"), set own enumerable properties with Object.defineProperty rather than ordinary assignment.',
            ...(testPrefixes.length ? [`Before finishing, add at least one new executable test file under ${testPrefixes.join(', ')} (protected existing tests do not count).`] : []),
          ].join('\n'),
          user: `Task:\n${req.contract.task}\n\nHuman write boundaries (file or directory prefix):\n${JSON.stringify(req.contract.writable)}\nProtected paths:\n${JSON.stringify(req.contract.protected)}\n\nRegistered checks: ${req.checks.map(c => c.name).join(', ')}\nBaseline:\n${baseline.text}${req.structuredFeedback ? '\nRequirement bindings (caller supplied; unverified means no current evidence):\n' + JSON.stringify(req.contract.requirements ?? []) : ''}`,
        };
        const provider = this.options.provider;
        const loop = new LoopExecutor({ ...this.options, provider: { name: provider.name, chat: async request => {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (req.maxCost !== null && (usage.costUsd === null || usage.costUsd >= req.maxCost)) {
            halt('budget_exhausted', usage.costUsd === null ? 'Cannot enforce cost cap: provider cost is unknown' : 'Cost cap reached');
            throw controller.signal.reason;
          }
          metrics.modelRequests++;
          const actual = { ...request, tools: request.tools.map(tool => tool.name === 'Write'
            ? { ...tool, description: 'Create or replace a file inside the human write boundaries. Protected paths and destructive overwrites are rejected.' } : tool) };
          emit('model_request', { model: actual.model, messages: actual.messages, tools: actual.tools, params: actual.params, temperature: actual.temperature });
          let lastError: unknown;
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await observer.run('proposal', () => provider.chat(actual));
              emit('model_response', response);
              return response;
            } catch (error) {
              lastError = error;
              usage = { ...usage, costUsd: null };
              emit('model_request_failed', { error: String(error), usageAvailable: false, attempt: attempt + 1 });
              if (!(error instanceof ProviderEnvError) || attempt >= PROVIDER_ENV_RETRIES || controller.signal.aborted) break;
              emit('warning', { text: `ProviderEnvError retry ${attempt + 1}/${PROVIDER_ENV_RETRIES}: ${String(error)}` });
              try { await delay(PROVIDER_ENV_RETRY_DELAY_MS * (attempt + 1), { signal: controller.signal }); }
              catch { break; }
            }
          }
          throw lastError;
        } } });
        result = await loop.run({ cwd: req.cwd, model: req.model, prompt, allowedTools: TOOLS, readOnlyDirs: [], subagents: [],
          maxTurns: req.maxTurns, maxBudgetUsd: req.maxCost, signal: controller.signal, salvageFromText: null,
          finishGuard, closeOnFinalizeReady: false, progressSignal: () => progress,
          progressHint: 'Implement the requested behavior and run registered checks after edits.',
          mcp: { tools: [{ name: 'mcp__task__check', description: 'Run all registered visible project checks on the current files.',
            schema: { type: 'object', properties: {}, additionalProperties: false } }], sdkServers: {}, pollingTools: [],
            call: async (server, tool, args) => server === 'task' && tool === 'check' && Object.keys(args).length === 0
              ? check(false) : { ok: false, text: 'Unknown check or arguments. Registered checks accept no arguments.' } },
        }, hooks);
        if (stop === null && result.ok && result.closedBy !== 'runtime' && finishGuard() === null) { stop = 'ready_for_review'; reason = 'Current visible checks passed; independent acceptance is still required'; }
        else if (stop === null) {
          stop = result.envFailure ? 'environment_error' : metrics.modelRequests >= req.maxTurns || (req.maxCost !== null && usage.costUsd !== null && usage.costUsd >= req.maxCost) ? 'budget_exhausted' : 'failed';
          reason = result.note;
        }
      }
    } catch (error) {
      if (stop === null) { stop = error instanceof ProviderEnvError ? 'environment_error' : 'failed'; reason = String(error); }
      emit('error', { reason: String(error) });
    } finally {
      clearTimeout(timer); req.signal.removeEventListener('abort', cancel);
      metrics.activeMs = performance.now() - started - metrics.humanWaitMs;
      end(controller.signal.aborted ? 'interrupted' : stop === 'ready_for_review' ? 'passed' : 'failed', { status: stop, reason });
    }
    let finalRevision = '';
    try { finalRevision = taskRevision(req.cwd); } catch { /* Invalid tree has no usable evidence. */ }
    const report: TaskLoopResult = { version: 1, status: stop ?? 'failed', reason, finalText: result?.finalText ?? '', usage,
      currency: this.options.currency ?? 'USD', checks, questions, metrics,
      requirements: requirementEvidence(req.contract.requirements ?? [], checks, finalRevision) };
    emit('result', report);
    return report;
  }
}
