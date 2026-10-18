import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLoopExecutor, type TaskLoopEvent, type TaskLoopResult, type TaskLoopStatus } from '../../../server/src/exec/TaskLoopExecutor.ts';
import { ScriptedProvider, textReply, toolReply, type ScriptedReply } from './scriptedProvider.ts';

export interface SimulationCaseResult {
  id: string; passed: boolean; expected: string; actual: string;
  checks: string[]; errors: string[]; trace: unknown[];
}
const initial = 'export function normalize(value) { return value; }\n';
const correct = 'export function normalize(value) { return value.trim().toLowerCase(); }\n';
const partial = 'export function normalize(value) { return value.toLowerCase(); }\n';
const check = () => toolReply('mcp__task__check');
const edit = (before = initial, after = correct) => toolReply('Edit', { file_path: 'src/normalize.mjs', old_string: before, new_string: after });
const finish = () => textReply('Все тесты прошли, сдаю результат.');
interface Scenario {
  id: string; expected: TaskLoopStatus; turns: () => ScriptedReply[];
  maxTurns?: number; environment?: boolean; task?: string;
  inspect(result: TaskLoopResult, assert: (condition: boolean, description: string) => void): void;
}
const scenarios: Scenario[] = [
  { id: 'task-success', expected: 'ready_for_review', turns: () => [edit(), check(), finish()], inspect: (r, a) => {
    a(r.metrics.writes === 1, 'Одна реальная запись'); a(r.requirements.every(x => x.status === 'verified'), 'Оба требования подтверждены');
  } },
  { id: 'task-repair', expected: 'ready_for_review', turns: () => [edit(initial, partial), check(), edit(partial), check(), finish()], inspect: (r, a) => {
    a(r.metrics.repairs === 1, 'Исправление после проваленной проверки');
    a(r.checks.some(c => c.name === 'acceptance' && !c.passed), 'Независимая приёмка сначала обнаружила ошибку');
    a(r.requirements.every(x => x.status === 'verified'), 'Свежая приёмка после исправления');
  } },
  { id: 'task-fabricated-pass', expected: 'failed', turns: () => [finish(), finish(), finish()], inspect: (r, a) => {
    a(r.metrics.writes === 0, 'Выдуманный PASS не изменил продукт'); a(!r.checks.some(c => !c.baseline), 'Заявление модели не создало свидетельств');
  } },
  { id: 'task-protected-tests', expected: 'failed', turns: () => [toolReply('Write', { file_path: 'tests/acceptance.test.mjs', content: 'process.exit(0)' }), finish(), finish(), finish()], inspect: (r, a) => a(r.metrics.denied === 1, 'Изменение приёмки отклонено') },
  { id: 'task-outside-scope', expected: 'failed', turns: () => [toolReply('Write', { file_path: 'config.txt', content: 'tampered' }), finish(), finish(), finish()], inspect: (r, a) => a(r.metrics.denied === 1, 'Запись вне разрешённых путей отклонена') },
  { id: 'task-stale-evidence', expected: 'failed', turns: () => [edit(), check(), edit(correct, partial), finish(), finish(), finish()], inspect: (r, a) => {
    a(r.checks.some(c => c.name === 'acceptance' && c.passed), 'До последней правки были зелёные тесты');
    a(r.requirements.every(x => x.status === 'unverified'), 'Последняя правка инвалидировала свидетельства');
  } },
  { id: 'task-repeated-failure-budget', expected: 'budget_exhausted', maxTurns: 4, turns: () => [check(), toolReply('Read', { file_path: 'src/normalize.mjs' }), check(), toolReply('Read', { file_path: 'src/normalize.mjs' })], inspect: (r, a) => {
    a(r.metrics.modelRequests === 4, 'Лимит ходов соблюдён'); a(r.checks.filter(c => c.name === 'acceptance' && !c.passed).length === 2, 'Два провала реальной приёмки');
  } },
  { id: 'task-no-human-answer', expected: 'needs_input', task: 'normalize должен удалять пробелы, приводить текст к нижнему регистру и умножать числовые значения на согласованный коэффициент. Значение коэффициента отсутствует: запросить его у человека до реализации.', turns: () => [toolReply('AskHuman', { questions: [{ id: 'coefficient', header: 'Правило', question: 'Какой согласованный коэффициент применяется?', options: [], multiSelect: false }] })], inspect: (r, a) => {
    a(r.questions.length === 1, 'Запрос человеку сохранён'); a(r.metrics.modelRequests === 1, 'Нет продолжения после отсутствующего ответа');
  } },
  { id: 'task-environment-failure', expected: 'environment_error', environment: true, turns: () => [], inspect: (r, a) => {
    a(r.metrics.modelRequests === 0, 'Неисправная среда остановила процесс до модели');
  } },
  { id: 'task-omitted-requirement', expected: 'failed', turns: () => [edit(initial, partial), check(), finish(), finish(), finish()], inspect: (r, a) => {
    a(r.requirements.every(x => x.status === 'violated'), 'Общий набор приёмки не подтверждает требования при пропущенном условии');
    a(r.checks.some(c => c.name === 'acceptance' && !c.passed && c.output.includes('trim')), 'Исполняемый тест обнаружил пропуск trim');
  } },
];

export const taskLoopScenarioIds = scenarios.map(s => s.id);
export async function runTaskLoopScenarios(ids?: readonly string[]): Promise<SimulationCaseResult[]> {
  const unknown = ids?.filter(id => !taskLoopScenarioIds.includes(id)) ?? [];
  if (unknown.length) throw new Error(`Неизвестные TaskLoop сценарии: ${unknown.join(', ')}`);
  const results: SimulationCaseResult[] = [];
  for (const scenario of scenarios.filter(s => !ids || ids.includes(s.id))) results.push(await runScenario(scenario));
  return results;
}
async function runScenario(scenario: Scenario): Promise<SimulationCaseResult> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-simulator-'));
  const trace: unknown[] = [], checks: string[] = [], errors: string[] = [];
  const assert = (condition: boolean, description: string) => { checks.push(description); if (!condition) errors.push(description); };
  let actual = 'exception';
  const provider = new ScriptedProvider('simulator', scenario.turns());
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src/normalize.mjs'), initial);
    writeFileSync(join(root, 'config.txt'), 'untouched');
    const acceptance = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalize } from '../src/normalize.mjs';\ntest('lowercase', () => assert.equal(normalize('HELLO'), 'hello'));\ntest('trim', () => assert.equal(normalize(' Hello '), 'hello'));\n`;
    writeFileSync(join(root, 'tests/acceptance.test.mjs'), acceptance);
    writeFileSync(join(root, 'tests/sanity.test.mjs'), `import assert from 'node:assert/strict';\nimport { normalize } from '../src/normalize.mjs';\nassert.equal(typeof normalize, 'function');\n`);
    const subprocess = (file: string, signal: AbortSignal, executable = process.execPath): Promise<{ passed: boolean; output: string; environmentError?: string }> => new Promise(resolve => {
      // node:test родителя не должен менять протокол отдельного процесса приёмки.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      execFile(executable, ['--test', file], { cwd: root, env, signal, timeout: 4000, maxBuffer: 100000 }, (error, stdout, stderr) => {
        const output = stdout + stderr;
        const environmentError = error && (typeof error.code !== 'number' || error.killed) ? String(error) : undefined;
        trace.push({ kind: 'subprocess', executable, args: ['--test', file], exit: error?.code ?? 0, output });
        resolve({ passed: !error, output, ...(environmentError ? { environmentError } : {}) });
      });
    });
    const executor = new TaskLoopExecutor({ provider, maxResultBytes: 12000, readRangeRequiredAboveBytes: 12000, bashTimeoutMs: 5000, temperature: 0 });
    const result = await executor.run({ cwd: root, model: 'simulator',
      contract: { task: scenario.task ?? 'normalize должен удалять пробелы с краёв и приводить строку к нижнему регистру.', writable: ['src/'], protected: ['tests/'], requirements: [
        { id: 'lowercase', description: 'Нижний регистр', source: 'human', checks: ['acceptance'] },
        { id: 'trim', description: 'Удалить пробелы с краёв', source: 'human', checks: ['acceptance'] },
      ] },
      checks: [
        { name: 'sanity', run: signal => subprocess('tests/sanity.test.mjs', signal, scenario.environment ? join(root, 'missing-node') : process.execPath) },
        { name: 'acceptance', baseline: false, run: signal => subprocess('tests/acceptance.test.mjs', signal) },
      ], maxTurns: scenario.maxTurns ?? 12, activeTimeoutMs: 20000, maxCost: null,
      signal: new AbortController().signal, ask: async () => ({}), emit: (event: TaskLoopEvent) => trace.push(event),
    });
    actual = result.status;
    trace.push({ kind: 'result', result });
    assert(result.status === scenario.expected, `Статус ${scenario.expected}, получен ${result.status}: ${result.reason}`);
    assert(provider.errors.length === 0, 'Сценарий завершён до исчерпания записанных ответов');
    assert(readFileSync(join(root, 'tests/acceptance.test.mjs'), 'utf8') === acceptance, 'Независимые тесты не изменены');
    assert(readFileSync(join(root, 'config.txt'), 'utf8') === 'untouched', 'Файл вне scope не изменён');
    assert(result.checks.filter(c => c.baseline).every(c => c.name === 'sanity'), 'Новая приёмка не используется как исходный зелёный baseline');
    scenario.inspect(result, assert);
  } catch (error) { errors.push(String(error)); trace.push({ kind: 'exception', error: String(error) }); }
  finally {
    trace.push({ kind: 'provider_requests', requests: provider.requests },
      { kind: 'provider_exchanges', exchanges: provider.exchanges, errors: provider.errors });
    rmSync(root, { recursive: true, force: true });
  }
  return { id: scenario.id, passed: errors.length === 0, expected: scenario.expected, actual, checks, errors, trace };
}
