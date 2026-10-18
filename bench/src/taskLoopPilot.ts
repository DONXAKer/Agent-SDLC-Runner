import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatProvider, ChatTurn } from '../../server/src/provider/ChatProvider.ts';
import type { ModelsConfig } from '../../server/src/config/schema.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { TaskLoopExecutor, inTaskPaths, taskRevision, type TaskLoopContract } from '../../server/src/exec/TaskLoopExecutor.ts';
import { BENCH_ONLY_FILE, prepareWorkspace } from './workspace.ts';
import { requireTaskFiles } from './tasks.ts';
import { classifyQuestion, readHumanScript } from './operator.ts';
import { spawnNode } from './nodeTest.ts';
import { hiddenOutcomeOf, runHiddenTests } from './hiddenTests.ts';
import { git } from '../../server/src/gates/git.ts';
import { additionalExecutedTests } from './taskLoopTestEvidence.ts';
import type { TaskRequirement } from '../../server/src/exec/taskEvidence.ts';

export interface PilotCase {
  task: string; writable: string[]; preserveExisting: string[]; exceptions: string[];
  requireNewTest: boolean; requireReadmeChange: boolean; requiredQuestionTags: string[];
  acceptanceFile?: string;
  requirements?: TaskRequirement[];
  visibleChecks?: { name: string; file: string }[];
  /** Explicit fixture for experiments outside the legacy task registry. */
  fixture?: { directory: string; taskFile: string; humanFile: string; hiddenFile: string };
}
export function pilotCases(root: string, casesFile = 'bench/experiments/task-loop-cases.json'): PilotCase[] {
  const within = (base: string, file: string): boolean => {
    const path = relative(resolve(root, base), resolve(root, file));
    return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
  };
  if (!within('bench/experiments', casesFile)) throw new Error('Experiment must be inside fingerprinted bench/experiments');
  const cases = (JSON.parse(readFileSync(resolve(root, casesFile), 'utf8')) as { cases: PilotCase[] }).cases;
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.task)).size !== cases.length)
    throw new Error('Nonempty experiment with unique task contracts required');
  if (cases.some(c => c.acceptanceFile && !within('bench/checks', c.acceptanceFile)))
    throw new Error('Acceptance checks must be inside fingerprinted bench/checks');
  for (const c of cases) {
    if (c.visibleChecks?.some(check => !within('bench/checks', check.file))) throw new Error('Visible checks must be inside fingerprinted bench/checks');
    if (c.fixture && (!within('bench/fixtures', c.fixture.directory)
      || !within(c.fixture.directory, c.fixture.taskFile) || !within(c.fixture.directory, c.fixture.humanFile)
      || !within('bench/checks', c.fixture.hiddenFile))) throw new Error('Fixture files must be inside fingerprinted fixture/check directories');
  }
  return cases;
}
function caseFiles(root: string, definition: PilotCase) {
  if (!definition.fixture) return requireTaskFiles(join(root, 'bench'), definition.task);
  const f = definition.fixture;
  return { fixtureDir: resolve(root, f.directory), taskFile: resolve(root, f.taskFile), humanFile: resolve(root, f.humanFile), hiddenFile: resolve(root, f.hiddenFile) };
}
export function sourceFingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const dir of ['server/src', 'shared/src', 'bench/src', 'bench/fixtures', 'bench/checks', 'bench/expected', 'bench/experiments', 'config']) {
    for (const file of treeFiles(join(root, dir))) hash.update(dir + '/' + file).update(readFileSync(join(root, dir, file)));
  }
  for (const file of ['tools/task-loop-pilot.ts', 'tools/compare-task-loop.ts']) if (existsSync(join(root, file))) hash.update(file).update(readFileSync(join(root, file)));
  return hash.digest('hex');
}
function treeFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Unsupported symbolic link: ${entry.name}`);
    if (['.git', '.runner', '.sdlc', 'node_modules'].includes(entry.name)) return [];
    const path = prefix + entry.name;
    return entry.isDirectory() ? treeFiles(root, path + '/') : [path];
  });
}
/** Shared artifact-independent scoring for both pilot and the legacy guided arm. */
export async function assessPilotTree(root: string, task: string, workspace: string, questionTags: (string | null)[], questionSources: string[], casesFile?: string) {
  const definition = pilotCases(root, casesFile).find(c => c.task === task);
  if (!definition) throw new Error('Unknown pilot contract');
  const files = caseFiles(root, definition);
  const script = readHumanScript(files.humanFile);
  const original = new Map(treeFiles(files.fixtureDir).filter(p => p.includes('/') || !BENCH_ONLY_FILE.test(p)).map(p => [p, readFileSync(join(files.fixtureDir, p))]));
  const final = new Map(treeFiles(workspace).map(p => [p, readFileSync(join(workspace, p))]));
  const changed = [...new Set([...original.keys(), ...final.keys()])].filter(p => !original.has(p) || !final.has(p) || !original.get(p)!.equals(final.get(p)!));
  const protectedPaths = [...script.approvals.denyWritesTo, ...[...original.keys()].filter(p => inTaskPaths(p, definition.preserveExisting) && !definition.exceptions.includes(p)), 'package.json', 'package-lock.json', 'scripts/'];
  const boundaryViolations = changed.filter(p => !inTaskPaths(p, definition.writable) || inTaskPaths(p, protectedPaths));
  const revision = taskRevision(workspace);
  const hidden = await runHiddenTests({ hiddenFile: files.hiddenFile, targetDir: workspace, timeoutMs: 60000 });
  const independent = definition.acceptanceFile ? await runHiddenTests({ hiddenFile: resolve(root, definition.acceptanceFile), targetDir: workspace, timeoutMs: 60000 }) : null;
  const originalPackage = JSON.parse(readFileSync(join(files.fixtureDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const testEvidence = definition.requireNewTest ? await additionalExecutedTests({ baselineDir: files.fixtureDir, targetDir: workspace,
    commandArgs: registeredNodeArgs(originalPackage.scripts['test']) }) : null;
  const obligations = { boundaries: boundaryViolations.length === 0,
    // runtime / ignored_after_green are executor answers — not bank misses (measured: meta-AskHuman falseSuccess).
    questions: questionSources.every(source => source === 'rule' || source === 'runtime' || source === 'ignored_after_green')
      && definition.requiredQuestionTags.every(tag => questionTags.includes(tag)),
    newTest: !definition.requireNewTest || testEvidence?.passed === true,
    documentation: !definition.requireReadmeChange || changed.includes('README.md'),
    stableTree: taskRevision(workspace) === revision,
    independent: independent === null || (independent.total > 0 && independent.fail === 0 && independent.skipped === 0 && independent.errorText === null),
    hidden: hidden.total > 0 && hidden.fail === 0 && hidden.skipped === 0 && hidden.errorText === null };
  return { gradingVersion: 3, changed, boundaryViolations, hidden, independent, testEvidence, obligations, behaviorPassed: Object.values(obligations).every(Boolean) };
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(path + '.tmp', path);
}

/** Trusted project scripts only. No shell, command substitution or model-supplied argv. */
export function registeredNodeArgs(script: unknown): string[] {
  if (typeof script !== 'string' || !script.startsWith('node ') || /[;&|`$<>\r\n]/u.test(script))
    throw new Error('Pilot supports registered Node scripts only; unsupported check command');
  const tokens = script.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/gu);
  if (!tokens || tokens.join(' ') !== script.trim()) throw new Error('Unsupported command quoting');
  return tokens.slice(1).map(token => token.replace(/^(["'])(.*)\1$/u, '$2'));
}

/** The current assistant can supply turns through the SAME LoopExecutor. Not a blind API control. */
export function sessionBridge(dir: string): ChatProvider {
  mkdirSync(dir, { recursive: true });
  let serial = 0;
  return { name: 'assistant-session', chat: async request => {
    const id = String(++serial).padStart(3, '0');
    const responsePath = join(dir, `${id}.response.json`);
    if (existsSync(responsePath)) throw new Error('Refusing to replay a stale bridge response');
    writeJson(join(dir, `${id}.request.json`), { model: request.model, messages: request.messages, tools: request.tools, params: request.params, temperature: request.temperature });
    writeJson(join(dir, 'pending.json'), { id, request: `${id}.request.json`, response: `${id}.response.json` });
    while (!existsSync(responsePath)) await delay(150, undefined, { signal: request.signal });
    const raw = JSON.parse(readFileSync(responsePath, 'utf8')) as { text?: string; calls?: { name: string; arguments: Record<string, unknown> }[] };
    if (typeof raw.text !== 'string' || !Array.isArray(raw.calls) || raw.calls.some(c => typeof c.name !== 'string' || !c.arguments || typeof c.arguments !== 'object'))
      throw new Error('Bridge response must contain text and calls');
    const response: ChatTurn = { text: raw.text, toolCalls: raw.calls.map((c, i) => ({ id: `${id}-${i}`, name: c.name, arguments: c.arguments, rawArguments: JSON.stringify(c.arguments) })),
      finishReason: raw.calls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 0 } };
    writeJson(join(dir, 'pending.json'), { id, answered: true });
    return response;
  } };
}

export interface PilotOptions { root: string; task: string; model: string; output: string; timeoutMs: number; maxTurns: number; maxCost: number | null; bridge?: string; casesFile?: string; structuredFeedback?: boolean }
export async function runTaskLoopPilot(options: PilotOptions) {
  const { root } = options;
  const definition = pilotCases(root, options.casesFile).find(c => c.task === options.task);
  if (!definition) throw new Error(`No human contract registered for ${options.task}`);
  const files = caseFiles(root, definition);
  const script = readHumanScript(files.humanFile);
  const models = JSON.parse(readFileSync(join(root, 'config/models.json'), 'utf8')) as ModelsConfig;
  const model = models.models.find(m => m.id === options.model);
  const providerDef = model ? models.providers[model.provider] : undefined;
  const bridge = options.model === 'assistant-session';
  if (bridge && !options.bridge) throw new Error('--bridge directory is required');
  if (!bridge && (!model || providerDef?.kind !== 'openai-compat' || providerDef.flow !== 'loop')) throw new Error('An explicit OpenAI-compatible loop route is required');
  const local = bridge || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[`${model!.provider.toUpperCase()}_BASE_URL`] ?? providerDef!.baseUrl!).hostname);
  if (!local && options.maxCost === null) throw new Error('Remote API control requires --max-cost in provider currency');
  const provider = bridge ? sessionBridge(resolve(options.bridge!)) : createProvider(model!.provider, providerDef!, options.timeoutMs);
  const dir = resolve(options.output); mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'result.json'))) throw new Error('Result already exists; use a fresh run directory');
  const sourceHash = sourceFingerprint(root);
  const ws = await prepareWorkspace({ fixtureDir: files.fixtureDir, slug: 'task-loop-pilot', branch: 'sdlc/task-loop-pilot' });
  const initial = new Map(treeFiles(ws.root).map(path => [path, readFileSync(join(ws.root, path))]));
  const protectedPaths = [...new Set([...script.approvals.denyWritesTo,
    ...[...initial.keys()].filter(path => inTaskPaths(path, definition.preserveExisting) && !definition.exceptions.includes(path)),
    'package.json', 'package-lock.json', 'scripts/'])];
  const testWritable = definition.writable
    .map(path => path.endsWith('/') ? path : `${path}/`)
    .filter(path => /(?:^|\/)tests?\//u.test(path));
  const contract: TaskLoopContract = { task: readFileSync(files.taskFile, 'utf8'), writable: definition.writable, protected: protectedPaths,
    allowDestructiveOverwrite: script.approvals.destructiveOverwrite === 'allow', requirements: definition.requirements ?? [],
    ...(definition.requireNewTest && testWritable.length > 0 ? { requireAdditionalTestsUnder: testWritable } : {}) };
  const packageJson = JSON.parse(readFileSync(join(ws.root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const commands = ['build', 'test'].map(name => ({ name, args: registeredNodeArgs(packageJson.scripts[name]) }));
  const controller = new AbortController();
  const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const asks: { id: string; question: string; source: string; tag: string | null }[] = [];
  let lastEvent: { at: string; kind: string } | null = null;
  const passport = { version: 1, task: options.task, model: options.model, sourceHash, workspace: ws.root, baseCommit: ws.baseCommit,
    contract, commands, structuredFeedback: options.structuredFeedback ?? false, visibleChecks: definition.visibleChecks ?? [], activeTimeoutMs: options.timeoutMs, maxTurns: options.maxTurns, maxCost: options.maxCost,
    params: model?.params ?? null, temperature: null, contextWindow: model?.contextWindow ?? null,
    casesFile: options.casesFile ?? 'bench/experiments/task-loop-cases.json', acceptanceFile: definition.acceptanceFile ?? null,
    control: bridge ? 'non-blind assistant session; same tool loop; token accounting unavailable' : local ? 'local' : 'remote-api', startedAt: new Date().toISOString() };
  writeJson(join(dir, 'passport.json'), passport);
  const heartbeat = setInterval(() => writeJson(join(dir, 'status.json'), { status: 'running', at: new Date().toISOString(), lastEvent, workspace: ws.root }), 5000);
  try {
    const executor = new TaskLoopExecutor({ provider, maxResultBytes: 16000, readRangeRequiredAboveBytes: 16000, bashTimeoutMs: 60000, temperature: null,
      params: model?.params ?? null, currency: providerDef?.currency ?? 'USD',
      ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model?.historyBudgetBytes === undefined ? {} : { historyBudgetBytes: model.historyBudgetBytes }) });
    const result = await executor.run({ cwd: ws.root, model: model?.model ?? options.model, contract, maxTurns: options.maxTurns,
      maxCost: options.maxCost, activeTimeoutMs: options.timeoutMs, signal: controller.signal, structuredFeedback: options.structuredFeedback ?? false,
      // Same order as measured evidence-cent-split repeatedErrors=5; stop before another identical dead-end repair.
      maxRepeatedErrors: 5,
      maxUnchangedFailures: 3,
      checks: [...commands.map(command => ({ name: command.name, run: async (signal: AbortSignal) => {
        const out = await spawnNode({ args: command.args, cwd: ws.root, signal, timeoutMs: Math.min(options.timeoutMs, 60000) });
        const output = out.stdout + out.stderr + (out.timedOut ? `\nCheck timed out after ${Math.min(options.timeoutMs, 60000)} ms` : '');
        // Timeout is a repairable FAIL, not environment_error (operator abort stays cancelled).
        return { passed: out.exitCode === 0 && !out.timedOut && !out.cancelled, output,
          ...(!out.timedOut && !out.cancelled && out.exitCode === null && out.stderr.trim() !== '' ? { environmentError: out.stderr } : {}) };
      } })), ...(definition.visibleChecks ?? []).map(check => ({ name: check.name, baseline: false, run: async (signal: AbortSignal) => {
        const out = await spawnNode({ args: ['--test', resolve(root, check.file)], cwd: ws.root,
          env: { BENCH_TARGET_DIR: ws.root }, signal, timeoutMs: Math.min(options.timeoutMs, 60000) });
        const output = out.stdout + out.stderr + (out.timedOut ? `\nCheck timed out after ${Math.min(options.timeoutMs, 60000)} ms` : '');
        return { passed: out.exitCode === 0 && !out.timedOut && !out.cancelled, output };
      } }))],
      ask: async questions => Object.fromEntries(questions.map(question => {
        const answer = classifyQuestion(script, question);
        asks.push({ id: question.id, question: question.question, source: answer.source, tag: answer.tag });
        return [question.id, answer.source === 'rule' ? answer.answer : []];
      })),
      emit: event => { appendFileSync(join(dir, 'events.ndjson'), JSON.stringify(event) + '\n'); lastEvent = { at: event.at, kind: event.kind }; },
    });
    const revision = taskRevision(ws.root);
    const final = new Map(treeFiles(ws.root).map(path => [path, readFileSync(join(ws.root, path))]));
    const changed = [...new Set([...initial.keys(), ...final.keys()])].filter(path => !initial.get(path)?.equals(final.get(path) ?? Buffer.alloc(0)) || !final.has(path));
    const boundaryViolations = changed.filter(path => !inTaskPaths(path, contract.writable) || inTaskPaths(path, contract.protected));
    for (const path of changed.filter(path => final.has(path))) { const target = join(dir, 'patch-files', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, final.get(path)!); }
    // Independent tests run only after the loop has stopped. Their output never enters its history.
    const assessment = await assessPilotTree(root, options.task, ws.root, asks.map(q => q.tag), asks.map(q => q.source), options.casesFile);
    const { hidden, obligations } = assessment;
    const patch = await git(['diff', '--no-ext-diff', 'HEAD', '--'], ws.root);
    writeFileSync(join(dir, 'tracked.patch'), patch.stdout);
    const acceptance = result.status === 'ready_for_review' && Object.values(obligations).every(Boolean);
    const hiddenOutcome = hiddenOutcomeOf(hidden);
    const readyWithUnverifiedRequirements = result.status === 'ready_for_review'
      && result.requirements.some(r => r.status === 'unverified');
    const report = { version: 1, passport, finishedAt: new Date().toISOString(), result, asks, changed, boundaryViolations,
      gradingVersion: assessment.gradingVersion, independent: assessment.independent, testEvidence: assessment.testEvidence,
      hidden, hiddenOutcome, readyWithUnverifiedRequirements, obligations, acceptance,
      falseSuccess: result.status === 'ready_for_review' ? !Object.values(obligations).every(Boolean) : null,
      frozenRevision: revision, limitations: ['Visible checks and hidden cases do not prove every semantic requirement.',
        'Documentation presence is checked; documentation meaning still requires review.',
        ...(bridge ? ['Assistant-session control is not blind and has no independent token/cost accounting.'] : [])] };
    writeJson(join(dir, 'result.json'), report);
    writeJson(join(dir, 'status.json'), { status: result.status, acceptance, finishedAt: report.finishedAt, hiddenOutcome });
    console.log(JSON.stringify({ output: dir, status: result.status, acceptance, hidden: `${hidden.pass}/${hidden.total}`,
      hiddenOutcome, requests: result.metrics.modelRequests }));
    return report;
  } catch (error) {
    writeJson(join(dir, 'status.json'), { status: 'environment_error', error: String(error), finishedAt: new Date().toISOString() });
    throw error;
  } finally { clearInterval(heartbeat); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); /* Keep isolated workspace for audit. */ }
}
