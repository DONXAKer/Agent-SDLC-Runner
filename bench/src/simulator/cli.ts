import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport, reportPassed, type SimulationReport, type Suite } from './report.ts';
import type { SimulationCaseResult } from './taskLoop.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const suites: Suite[] = ['task-loop', 'guided', 'full-flow'];

function options(args: string[]): { suites: Suite[]; output: string | null; image: string | null } {
  let selection: Suite[] = suites;
  let output: string | null = null;
  let image: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (flag === '--suite' && (value === 'all' || value === 'state-first' || value === 'guided-v4-full-flow' || value === 'guided-v5-full-flow' || suites.includes(value as Suite))) selection = value === 'all' ? suites : [value as Suite];
    else if (flag === '--output' && value && !value.startsWith('--')) output = resolve(value);
    else if (flag === '--docker-image' && value && !value.startsWith('--')) image = value;
    else throw new Error(`Неизвестный аргумент или отсутствует значение: ${flag}. Используй --help.`);
  }
  if (selection.includes('state-first') && !image) throw new Error('state-first требует --docker-image <локальный образ Node>');
  if (selection.includes('guided-v4-full-flow') && !image) throw new Error('guided-v4-full-flow требует --docker-image <локальный образ Node>');
  if (selection.includes('guided-v5-full-flow') && !image) throw new Error('guided-v5-full-flow requires --docker-image');
  if (image && selection === suites) selection = [...selection, 'state-first', 'guided-v4-full-flow'];
  return { suites: selection, output, image };
}

function sources(): string {
  const hash = createHash('sha256');
  // Снимок включает незакоммиченные исходники, сценарии и lockfile; без результатов, секретов и node_modules.
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Источник симулятора не должен быть симлинком: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (/\.(ts|mjs|json|md)$/.test(name)) hash.update(relative(repository, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const folder of ['server/src', 'server/methodology', 'shared/src', 'bench/src', 'server/test/fixtures/guided-v4', 'bench/fixtures/guided-process']) walk(join(repository, folder));
  hash.update(readFileSync(join(repository, 'package.json')));
  hash.update(readFileSync(join(repository, 'package-lock.json')));
  return hash.digest('hex');
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log('npm run bench:simulate -- [--suite all|task-loop|guided|full-flow|guided-v4-full-flow|state-first] [--docker-image локальный-образ-Node] [--output новый-или-пустой-каталог]\nБез модели/GPU. State-first требует Docker и явный образ; --docker-image добавляет этот набор к all. Код 0: ожидания выполнены; 1: сценарий не прошёл (включая исключение); 2: ошибка запуска или набора.');
    return;
  }
  const opts = options(process.argv.slice(2));
  const output = opts.output ?? mkdtempSync(join(tmpdir(), 'sdlc-simulation-report-'));
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory() || readdirSync(output).length)) {
    throw new Error(`Каталог отчёта должен быть новым или пустым: ${output}`);
  }
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'traces'));
  const state = mkdtempSync(join(tmpdir(), 'sdlc-simulator-state-'));
  // Даже явно заданное пользовательское хранилище не используется испытанием.
  const previousState = process.env.SDLC_STATE_DIR;
  process.env.SDLC_STATE_DIR = state;
  const startedAt = new Date().toISOString();
  const cases: SimulationReport['cases'] = [];
  try {
    const sourceHash = sources();
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim() !== '';
    for (const suite of opts.suites) {
      console.log(`Испытание ${suite}…`);
      let results: SimulationCaseResult[];
      try {
        // Импорт после установки SDLC_STATE_DIR: внешнее хранилище вердиктов также одноразовое.
        if (suite === 'task-loop') results = await (await import('./taskLoop.ts')).runTaskLoopScenarios();
        else if (suite === 'guided') results = await (await import('./guided.ts')).runGuidedScenarios();
        else if (suite === 'full-flow') results = await (await import('./fullFlow.ts')).runFullFlowScenarios();
        else if (suite === 'guided-v4-full-flow') results = await (await import('./guidedV4.ts')).runGuidedV4Scenarios(opts.image!);
        else if (suite === 'guided-v5-full-flow') results = await (await import('./guidedV4.ts')).runGuidedV4Scenarios(opts.image!, undefined, 5);
        else results = await (await import('./stateFirst.ts')).runStateFirstScenarios(opts.image!);
      } catch (error) {
        results = [{ id: `${suite}-harness-error`, passed: false, expected: 'Стенд выполнил сценарии', actual: 'Ошибка стенда',
          checks: [], errors: [String(error)], trace: [] }];
      }
      if (!results.length) results.push({ id: `${suite}-empty`, passed: false, expected: 'Непустой набор', actual: 'Нет сценариев', checks: [], errors: ['Пустой набор'], trace: [] });
      for (const result of results) {
        if (!/^[a-z0-9-]+$/.test(result.id)) throw new Error(`Неверный id сценария: ${result.id}`);
        const { trace, ...summary } = result;
        const traceFile = `traces/${suite}-${result.id}.json`;
        writeFileSync(join(output, traceFile), JSON.stringify(trace, null, 2) + '\n', { flag: 'wx' });
        const passed = reportPassed([result]);
        cases.push({ ...summary, passed, suite, traceFile });
        console.log(`  ${passed ? 'PASS' : 'FAIL'} ${result.id}: ${result.actual}`);
      }
    }
    const report: SimulationReport = { version: 1, kind: 'deterministic-runtime-simulation', startedAt,
      finishedAt: new Date().toISOString(), revision, dirty, sourceHash, node: process.version,
      suites: opts.suites, passed: reportPassed(cases), cases };
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(join(output, 'report.md'), renderReport(report), { flag: 'wx' });
    console.log(`Отчёт: ${join(output, 'report.md')}`);
    process.exitCode = report.passed ? 0 : cases.some(c => c.id.endsWith('-harness-error')) ? 2 : 1;
  } finally {
    rmSync(state, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.SDLC_STATE_DIR;
    else process.env.SDLC_STATE_DIR = previousState;
  }
}

main().catch(error => { console.error(String(error)); process.exitCode = 2; });
