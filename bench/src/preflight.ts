/**
 * Преполётный тест (`--preflight` и автогейт живых прогонов).
 *
 * Зачем: журналы замеров (`docs/model-runs.md`, `docs/model-task-matrix.md`,
 * `docs/proposals/model-flow-improvements.md` §1) описывают классы отказов, которые
 * сжигали часы стенных часов и бюджет ДО первого осмысленного вызова модели: голый
 * тег Ollama с окном 4096, мёртвый тег с HTTP 404 на каждый запрос, лёгший движок
 * LM Studio, битая фикстура, отсутствующий снимок. Всё это проверяется за секунды —
 * и обязано проверяться до того, как серия `--repeat 5` уйдёт в ночь.
 *
 * Модельные проверки — расширенная проба (`PREFLIGHT_CASES`): поверх трёх базовых
 * микро-кейсов tool-calling — точность многострочного Edit («некорректная запись»),
 * честность путей («выдумывание»), длинная запись без усечения («нехватка токенов
 * на ответ», `finish_reason: length`).
 *
 * Коды исхода — как у всего бенчмарка: 0 — пройдено, 1 — модель не прошла,
 * 2 — измерение не состоялось (среда/конфиг). Логика кодов живёт здесь одна
 * (`preflightExitCode`), чтобы режим `--preflight` и автогейт не разъехались.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { STAGE_ORDER } from '@sdlc-runner/shared';

import { loadConfig } from '../../server/src/config/load.ts';
import { estimateMessageTokens } from '../../server/src/exec/contextBudget.ts';
import { readSkillBody } from '../../server/src/prompt/build.ts';
import { stageById } from '../../server/src/run/stages.ts';
import { PREFLIGHT_CASES, PROBE_CASE_TIMEOUT_MS, probeModel, resolveProbeTarget } from '../../server/src/probe.ts';
import type { ProbeReport } from '../../server/src/probe.ts';
import { contextProblemFor } from '../../server/src/provider/contextCheck.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { spawnNodeTest } from './nodeTest.ts';
import type { NodeTestOutput } from './nodeTest.ts';
import { readHumanScript } from './operator.ts';
import { buildProfile, measuredStages, readControl } from './profile.ts';
import { taskById, taskPaths } from './tasks.ts';
import type { BenchOptions } from './options.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface PreflightCheck {
  name: string;
  ok: boolean;
  /** Средовая/конфигурационная проверка (true) или наблюдение о модели (false). */
  env: boolean;
  detail: string;
  durationMs: number;
}

export interface PreflightReport {
  model: string;
  task: string;
  checks: PreflightCheck[];
  passed: boolean;
  envBlocked: boolean;
}

/** Единственное место, решающее код возврата преполёта — режим и автогейт делят его. */
export function preflightExitCode(report: PreflightReport): number {
  if (report.passed) return 0;
  return report.envBlocked ? 2 : 1;
}

/** Текстовый отчёт для консоли. Чистая функция — проверяется без сети и процессов. */
export function formatPreflight(report: PreflightReport): string {
  const lines = [
    `Преполётный тест: ${report.model} · задача ${report.task}`,
    ...report.checks.map(
      (c) => `  ${c.ok ? '✅' : c.env ? '⛔' : '❌'} ${c.name} — ${c.detail} (${(c.durationMs / 1000).toFixed(1)} с)`,
    ),
    report.passed
      ? 'Преполёт зелёный: среду и модель можно ставить на долгий прогон. Это скрининг, не замер этапа.'
      : report.envBlocked
        ? 'Преполёт КРАСНЫЙ по среде/конфигу: прогон не начинался бы о модели — почини среду и повтори.'
        : 'Преполёт КРАСНЫЙ по модели: микро-кейсы не пройдены — долгий прогон не оправдан.',
  ];
  return lines.join('\n');
}

/** Точка подмены для тестов: сеть и дочерние процессы не поднимаются вовсе. */
export interface PreflightDeps {
  probe: typeof probeModel;
  contextProblem: typeof contextProblemFor;
  spawnTest: typeof spawnNodeTest;
  spawnScript: (args: { script: string; cwd: string; timeoutMs: number }) => Promise<NodeTestOutput>;
  benchDir: string;
  snapshotsDir: string;
  controlFile: string;
}

function defaultDeps(): PreflightDeps {
  return {
    probe: probeModel,
    contextProblem: contextProblemFor,
    spawnTest: spawnNodeTest,
    spawnScript: spawnNodeScript,
    benchDir: BENCH_DIR,
    snapshotsDir: join(BENCH_DIR, 'snapshots'),
    controlFile: join(BENCH_DIR, 'control.json'),
  };
}

const FIXTURE_CHECK_TIMEOUT_MS = 120_000;

/** Дочерний `node <script>` — для `scripts/build-check.mjs` фикстур (без --test). */
function spawnNodeScript(args: { script: string; cwd: string; timeoutMs: number }): Promise<NodeTestOutput> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [args.script], {
      cwd: args.cwd,
      env: process.env,
      windowsHide: true,
    });
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, args.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout: out.join(''), stderr: err.join(''), timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout: '', stderr: e.message, timedOut });
    });
  });
}

const ok = (name: string, env: boolean, detail: string, durationMs = 0): PreflightCheck => ({
  name,
  ok: true,
  env,
  detail,
  durationMs,
});
const bad = (name: string, env: boolean, detail: string, durationMs = 0): PreflightCheck => ({
  name,
  ok: false,
  env,
  detail,
  durationMs,
});

/** Файлы задачи и эталон скрытых тестов — то, что `taskFiles` в cli.ts проверяет броском. */
function checkTaskFiles(deps: PreflightDeps, task: string): PreflightCheck {
  const started = Date.now();
  const name = 'задача: файлы фикстуры';
  const def = taskById(task as BenchOptions['task']);
  const files = taskPaths(deps.benchDir, def);
  if (!existsSync(files.fixtureDir)) {
    return bad(name, true, `каталога фикстуры ${def.fixtureDir} нет на диске`, Date.now() - started);
  }
  for (const f of [files.taskFile, files.humanFile, files.expectedFile, files.hiddenFile]) {
    if (!existsSync(f)) return bad(name, true, `нет файла ${f}`, Date.now() - started);
  }
  try {
    JSON.parse(readFileSync(files.expectedFile, 'utf8'));
  } catch (e) {
    return bad(name, true, `эталон ${files.expectedFile} не парсится: ${(e as Error).message}`, Date.now() - started);
  }
  return ok(name, true, 'задача, банк ответов, эталон и скрытый тест на месте', Date.now() - started);
}

/**
 * Банк ответов человека. Вопрос мимо правил уходит в fallback, а на задачах, где ответ
 * человека и есть предмет измерения (`security-bait`, `two-right-answers`), fallback ломает
 * само измерение — серия v4 дала 21 такой вопрос, и видно это было только после прогона.
 */
function checkAnswerBank(deps: PreflightDeps, task: string): PreflightCheck {
  const started = Date.now();
  const name = 'задача: банк ответов человека';
  const files = taskPaths(deps.benchDir, taskById(task as BenchOptions['task']));
  try {
    const script = readHumanScript(files.humanFile);
    const rules = script.answers.rules.length;
    if (rules === 0) {
      return bad(name, true, `в ${files.humanFile} нет ни одного правила ответа — каждый вопрос модели уйдёт в fallback`, Date.now() - started);
    }
    return ok(
      name,
      true,
      `правил ответа ${rules}, шумовых тегов ${script.answers.noise.length}; вопрос мимо них уйдёт в fallback — число таких в отчёте`,
      Date.now() - started,
    );
  } catch (e) {
    return bad(name, true, (e as Error).message, Date.now() - started);
  }
}

/**
 * Лимит ходов стенда против штатного. Не красный: `--max-turns` ниже штатного — право
 * оператора. Но отказ «исчерпан лимит ходов» в такой серии мерит стенд, а не модель
 * (серия v4: три клетки из 25 при бенч-умолчании 25), и это должно быть написано ДО прогона.
 */
function checkTurnLimit(opts: BenchOptions): PreflightCheck {
  const name = 'стенд: лимит ходов';
  const prod = loadConfig().runner.limits.maxIterationsPerStage;
  return opts.maxIterationsPerStage >= prod
    ? ok(name, true, `ходов на этап ${opts.maxIterationsPerStage} (штатно ${prod})`)
    : ok(
        name,
        true,
        `⚠ ходов на этап ${opts.maxIterationsPerStage} НИЖЕ штатных ${prod}: отказ «исчерпан лимит ходов» в этой серии мерит стенд, а не модель`,
      );
}

/**
 * Нижняя граница промпта этапа plan против окна маршрута. Считается только системная часть —
 * тело скилла из эталона: входные артефакты (задача, готовность, отчёт разведки) лягут
 * сверху, и в серии v4 они были крупнее самой системной части (≈19 тыс. против ≈14 тыс.
 * символов). Отсюда пороги: красный — когда не влезает уже граница, половина окна —
 * предупреждение. Переполнение на plan (серии v4 и v5) до сих пор становилось видно
 * красной клеткой после прогона, а не за секунды до него.
 */
function checkPlanPromptFits(deps: PreflightDeps, opts: BenchOptions): PreflightCheck | null {
  if (!measuredStages(opts.mode).includes('plan')) return null;
  const started = Date.now();
  const name = 'модель: промпт plan против окна';
  const config = loadConfig();
  const control = readControl(deps.controlFile);
  const built = buildProfile({ projectRoot: deps.benchDir, models: config.models, control, opts });
  const window = built.profile.routes.plan.contextWindow;
  let body: string;
  try {
    body = readSkillBody(config.runner.skillsDir, stageById('plan').skill);
  } catch {
    return ok(name, true, 'эталон скиллов не найден — оценка пропущена (прогон упадёт на сборке промпта раньше модели)');
  }
  const tokens = estimateMessageTokens([{ content: body }]);
  const ms = Date.now() - started;
  if (window === undefined) {
    return ok(name, true, `⚠ окно маршрута plan не задано — системная часть ≈${tokens} токенов, переполнение не предсказать: заполни contextWindow`, ms);
  }
  if (tokens >= window) {
    return bad(name, true, `системная часть промпта plan ≈${tokens} токенов уже не меньше окна ${window}`, ms);
  }
  if (tokens * 2 > window) {
    return ok(name, true, `⚠ системная часть plan ≈${tokens} токенов — больше половины окна ${window}; со входными артефактами переполнение вероятно`, ms);
  }
  return ok(name, true, `системная часть plan ≈${tokens} токенов при окне ${window}`, ms);
}

/** Контрольный маршрут и профиль: сборка до рабочей копии, а не посреди неё. */
function checkProfile(deps: PreflightDeps, opts: BenchOptions): PreflightCheck {
  const started = Date.now();
  const name = 'конфиг: контрольный маршрут';
  try {
    const config = loadConfig();
    const control = readControl(deps.controlFile);
    buildProfile({ projectRoot: deps.benchDir, models: config.models, control, opts });
    return ok(name, true, `маршрут «${control.label}» собирается`, Date.now() - started);
  } catch (e) {
    return bad(name, true, (e as Error).message, Date.now() - started);
  }
}

/** Тестовые файлы фикстуры — явным списком, без glob: glob разворачивает не шелл
 * (spawn идёт без него), а поддержка шаблонов в `node --test` зависит от версии. */
function collectFixtureTests(fixtureDir: string): string[] {
  const testDir = join(fixtureDir, 'test');
  if (!existsSync(testDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.mjs') || e.name.endsWith('.test.js')) out.push(p);
    }
  };
  walk(testDir);
  return out;
}

/**
 * Зелёность фикстуры: `scripts/build-check.mjs` (если есть) и тесты фикстуры.
 * Намеренно красные семейства (`expectFixtureRed` в tasks.ts: broken-assert, flaky-test)
 * инвертируют проверку тестов: зелёная фикстура там значит, что задача потеряла предмет.
 */
async function checkFixture(deps: PreflightDeps, opts: BenchOptions): Promise<PreflightCheck[]> {
  const name = 'фикстура';
  const def = taskById(opts.task);
  const fixtureDir = join(deps.benchDir, def.fixtureDir);
  const expectRed = def.expectFixtureRed === true;

  const checks: PreflightCheck[] = [];
  const buildCheck = join(fixtureDir, 'scripts', 'build-check.mjs');
  if (existsSync(buildCheck)) {
    const started = Date.now();
    const r = await deps.spawnScript({ script: buildCheck, cwd: fixtureDir, timeoutMs: FIXTURE_CHECK_TIMEOUT_MS });
    const ms = Date.now() - started;
    if (r.timedOut) return [bad(`${name}: сборка`, true, `build-check.mjs снят по таймауту ${FIXTURE_CHECK_TIMEOUT_MS} мс`, ms)];
    if (r.exitCode !== 0) {
      return [bad(`${name}: сборка`, true, `build-check.mjs завершился кодом ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, ms)];
    }
    checks.push(ok(`${name}: сборка`, true, 'build-check.mjs зелёный', ms));
  }

  const tests = collectFixtureTests(fixtureDir);
  if (tests.length === 0) {
    return [...checks, ok(`${name}: тесты`, true, 'тестов у фикстуры нет — проверять нечего')];
  }
  const started = Date.now();
  const r = await deps.spawnTest({ testArgs: tests, cwd: fixtureDir, timeoutMs: FIXTURE_CHECK_TIMEOUT_MS });
  const ms = Date.now() - started;
  if (r.timedOut) return [...checks, bad(`${name}: тесты`, true, `сняты по таймауту ${FIXTURE_CHECK_TIMEOUT_MS} мс`, ms)];
  const green = r.exitCode === 0;
  if (expectRed) {
    return green
      ? [...checks, bad(`${name}: тесты`, true, 'фикстура ЗЕЛЁНАЯ, а задача ждёт намеренно красную — чинить/флапать больше нечему', ms)]
      : [...checks, ok(`${name}: тесты`, true, 'намеренно красная фикстура подтверждена красной', ms)];
  }
  return green
    ? [...checks, ok(`${name}: тесты`, true, `нетронутая фикстура зелёная (${tests.length} файлов)`, ms)]
    : [...checks, bad(`${name}: тесты`, true, `нетронутая фикстура КРАСНАЯ (код ${r.exitCode}) — прогон измерит битую среду, а не модель`, ms)];
}

/** Снимок `--from-snapshot`: существование, мета, принадлежность задаче, точка снимка. */
function checkSnapshot(deps: PreflightDeps, opts: BenchOptions): PreflightCheck | null {
  if (opts.fromSnapshot === null) return null;
  const started = Date.now();
  const name = 'снимок';
  const dir = join(deps.snapshotsDir, opts.fromSnapshot);
  if (!existsSync(dir)) return bad(name, true, `снимка «${opts.fromSnapshot}» нет в ${deps.snapshotsDir}`, Date.now() - started);
  const metaFile = join(dir, 'snapshot.json');
  if (!existsSync(metaFile)) return bad(name, true, `${dir}: нет snapshot.json — это не снимок бенчмарка`, Date.now() - started);
  let meta: { task?: unknown; stoppedAfterStage?: unknown };
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8')) as typeof meta;
  } catch (e) {
    return bad(name, true, `snapshot.json не парсится: ${(e as Error).message}`, Date.now() - started);
  }
  if (meta.task !== opts.task) {
    return bad(name, true, `снимок снят для задачи «${String(meta.task)}», прогон — для «${opts.task}»`, Date.now() - started);
  }
  const first = measuredStages(opts.mode)[0];
  const point = STAGE_ORDER.indexOf(meta.stoppedAfterStage as (typeof STAGE_ORDER)[number]);
  if (first !== undefined && (point === -1 || point >= STAGE_ORDER.indexOf(first))) {
    return bad(
      name,
      true,
      `точка снимка «${String(meta.stoppedAfterStage)}» не раньше первого измеряемого этапа «${first}» — прогону нечего мерить`,
      Date.now() - started,
    );
  }
  return ok(name, true, `снимок «${opts.fromSnapshot}» на месте, задача совпадает`, Date.now() - started);
}

/** Окно контекста измеряемых маршрутов (LM Studio — фактическое, Ollama — зашитое/4096). */
async function checkContextWindows(deps: PreflightDeps, opts: BenchOptions): Promise<PreflightCheck[]> {
  const name = 'модель: окно контекста';
  const config = loadConfig();
  const control = readControl(deps.controlFile);
  const built = buildProfile({ projectRoot: deps.benchDir, models: config.models, control, opts });
  const seen = new Set<string>();
  const out: PreflightCheck[] = [];
  for (const stage of built.measured) {
    const route = built.profile.routes[stage];
    const key = `${route.provider}/${route.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const started = Date.now();
    const problem = await deps.contextProblem(route.provider, route.model, route.contextWindow, route.providerDef.baseUrl);
    const ms = Date.now() - started;
    if (problem !== null) out.push(bad(name, true, problem, ms));
  }
  if (out.length === 0) out.push(ok(name, true, 'окна измеряемых маршрутов в порядке (или провайдер без управляемого окна)'));
  return out;
}

/** Модельные кейсы пробы — только флоу loop; sdk-флоу проба не меряет (resolveProbeTarget). */
async function checkModel(deps: PreflightDeps, opts: BenchOptions): Promise<PreflightCheck[]> {
  const config = loadConfig();
  const target = resolveProbeTarget(config.models, opts.model);
  if ('error' in target) {
    // «Флоу sdk» — проба неприменима, это не красное; остальные ошибки (модель не
    // найдена, провайдер не описан) — конфигурационный отказ, средовый класс.
    if (target.error.includes('флоу')) {
      return [ok('модель: проба tool-calling', false, 'флоу sdk — проба не применяется, модельные кейсы пропущены')];
    }
    return [bad('модель: конфиг', true, target.error)];
  }
  const { def, providerDef } = target;
  const provider = createProvider(def.provider, providerDef, config.runner.limits.chatTimeoutMs);
  const report: ProbeReport = await deps.probe({
    provider,
    model: def.model,
    params: def.params ?? null,
    caseTimeoutMs: PROBE_CASE_TIMEOUT_MS,
    cases: PREFLIGHT_CASES,
  });
  return report.cases.map((c) => ({
    name: `модель: ${c.name}`,
    ok: c.ok,
    env: c.env,
    detail: c.detail,
    durationMs: c.durationMs,
  }));
}

/**
 * Полный преполёт: средовые проверки (без вызовов модели), затем — только если среда
 * зелёная — модельные (окно + расширенная проба). Дергать модель при красной среде
 * бессмысленно: её красное читалось бы как вина модели рядом с настоящей причиной.
 */
export async function runPreflight(opts: BenchOptions, deps: Partial<PreflightDeps> = {}): Promise<PreflightReport> {
  const d: PreflightDeps = { ...defaultDeps(), ...deps };
  const taskCheck = checkTaskFiles(d, opts.task);
  const checks: PreflightCheck[] = [taskCheck, ...(taskCheck.ok ? [checkAnswerBank(d, opts.task)] : []), checkProfile(d, opts)];
  checks.push(...(await checkFixture(d, opts)));
  const snap = checkSnapshot(d, opts);
  if (snap !== null) checks.push(snap);

  const envOkSoFar = checks.every((c) => c.ok);
  if (envOkSoFar) {
    checks.push(checkTurnLimit(opts));
    const planFit = checkPlanPromptFits(d, opts);
    if (planFit !== null) checks.push(planFit);
    checks.push(...(await checkContextWindows(d, opts)));
    if (checks.every((c) => c.ok)) {
      checks.push(...(await checkModel(d, opts)));
    }
  }

  return {
    model: opts.model,
    task: opts.task,
    checks,
    passed: checks.every((c) => c.ok),
    envBlocked: checks.some((c) => !c.ok && c.env),
  };
}
