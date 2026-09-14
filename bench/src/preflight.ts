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

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../server/src/config/load.ts';
import type { LoadedConfig } from '../../server/src/config/load.ts';
import { estimateMessageTokens } from '../../server/src/exec/contextBudget.ts';
import { readSkillBody } from '../../server/src/prompt/build.ts';
import { stageById } from '../../server/src/run/stages.ts';
import { PREFLIGHT_CASES, PROBE_CASE_TIMEOUT_MS, probeModel, resolveProbeTarget } from '../../server/src/probe.ts';
import type { ProbeReport } from '../../server/src/probe.ts';
import { contextProblemFor } from '../../server/src/provider/contextCheck.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { spawnNode, spawnNodeTest } from './nodeTest.ts';
import type { NodeTestOutput } from './nodeTest.ts';
import { readHumanScript } from './operator.ts';
import { buildProfile, measuredStages, readControl } from './profile.ts';
import type { BuiltProfile, ControlFile } from './profile.ts';
import { SnapshotError, firstMeasuredFrom, readSnapshotMeta, startStageAfter } from './snapshot.ts';
import { fixtureColorOf, taskById, taskFilesProblem, taskPaths } from './tasks.ts';
import { resolveTurnLimits } from './options.ts';
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

/** Точка подмены для тестов: сеть, дочерние процессы и конфиг машины подменяются. */
export interface PreflightDeps {
  probe: typeof probeModel;
  contextProblem: typeof contextProblemFor;
  spawnTest: typeof spawnNodeTest;
  spawnScript: (args: { script: string; cwd: string; timeoutMs: number }) => Promise<NodeTestOutput>;
  loadConfig: () => LoadedConfig;
  benchDir: string;
  snapshotsDir: string;
  controlFile: string;
}

function defaultDeps(): PreflightDeps {
  return {
    probe: probeModel,
    contextProblem: contextProblemFor,
    spawnTest: spawnNodeTest,
    // Общий спавн `nodeTest.ts`: своя копия здесь не сбрасывала NODE_TEST_CONTEXT, и
    // `build-check.mjs` фикстуры из-под тестового прогона вёл себя иначе, чем в бою.
    spawnScript: ({ script, cwd, timeoutMs }) => spawnNode({ args: [script], cwd, timeoutMs }),
    loadConfig,
    benchDir: BENCH_DIR,
    snapshotsDir: join(BENCH_DIR, 'snapshots'),
    controlFile: join(BENCH_DIR, 'control.json'),
  };
}

/**
 * Конфиг, контрольный маршрут и профиль — загружаются ОДИН раз на преполёт и отдаются
 * проверкам. Прежде каждая проверка грузила их сама (конфиг пять раз, профиль трижды):
 * лишняя работа и, хуже, пять возможностей увидеть разный конфиг в одном отчёте.
 */
interface PreflightContext {
  config: LoadedConfig;
  control: ControlFile;
  built: BuiltProfile;
}

const FIXTURE_CHECK_TIMEOUT_MS = 120_000;

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

/** Файлы задачи и эталон скрытых тестов — та же проверка, что бросает CLI (`requireTaskFiles`). */
function checkTaskFiles(deps: PreflightDeps, task: string): PreflightCheck {
  const started = Date.now();
  const name = 'задача: файлы фикстуры';
  const def = taskById(task);
  const problem = taskFilesProblem(taskPaths(deps.benchDir, def), def);
  return problem === null
    ? ok(name, true, 'задача, банк ответов, эталон и скрытый тест на месте', Date.now() - started)
    : bad(name, true, problem, Date.now() - started);
}

/**
 * Банк ответов человека. Вопрос мимо правил уходит в fallback, а на задачах, где ответ
 * человека и есть предмет измерения (`security-bait`, `two-right-answers`), fallback ломает
 * само измерение — серия v4 дала 21 такой вопрос, и видно это было только после прогона.
 */
function checkAnswerBank(deps: PreflightDeps, task: string): PreflightCheck {
  const started = Date.now();
  const name = 'задача: банк ответов человека';
  const files = taskPaths(deps.benchDir, taskById(task));
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
 *
 * Предупреждение — только при ЯВНОМ `--max-turns`: без ключа виток получает штатный лимит
 * конфига (`resolveTurnLimits`), и сравнивать с ним константу разбора значило бы вечное «⚠»
 * после любой правки `runner.json`. Явный ключ снимает и поэтапные потолки — поэтому ниже
 * штатного он может оказаться и на одном этапе (verify: 60).
 */
function checkTurnLimit(config: LoadedConfig, opts: BenchOptions): PreflightCheck {
  const name = 'стенд: лимит ходов';
  const prod = config.runner.limits;
  const limits = resolveTurnLimits(prod, opts);
  if (!limits.maxTurnsExplicit) {
    const byStage = Object.entries(limits.maxIterationsByStage).map(([s, n]) => `${s} ${n}`).join(', ');
    return ok(name, true, `ходов на этап ${limits.maxTurns} — штатный лимит конфига${byStage === '' ? '' : `, поэтапно: ${byStage}`}`);
  }
  const lowered = Object.entries(prod.maxIterationsByStage ?? {})
    .filter(([, n]) => n !== undefined && n > limits.maxTurns)
    .map(([s, n]) => `${s} ${n}`);
  if (limits.maxTurns >= prod.maxIterationsPerStage && lowered.length === 0) {
    return ok(name, true, `ходов на этап ${limits.maxTurns} (явный --max-turns; штатно ${prod.maxIterationsPerStage})`);
  }
  const where = [
    ...(limits.maxTurns < prod.maxIterationsPerStage ? [`штатных ${prod.maxIterationsPerStage}`] : []),
    ...(lowered.length === 0 ? [] : [`поэтапных потолков (${lowered.join(', ')})`]),
  ].join(' и ');
  return ok(
    name,
    true,
    `⚠ ходов на этап ${limits.maxTurns} НИЖЕ ${where}: отказ «исчерпан лимит ходов» в этой серии мерит стенд, а не модель`,
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
function checkPlanPromptFits(ctx: PreflightContext, opts: BenchOptions): PreflightCheck | null {
  if (!measuredStages(opts.mode).includes('plan')) return null;
  const started = Date.now();
  const name = 'модель: промпт plan против окна';
  const window = ctx.built.profile.routes.plan.contextWindow;
  let body: string;
  try {
    body = readSkillBody(ctx.config.runner.skillsDir, stageById('plan').skill);
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

/**
 * Контрольный маршрут и профиль: сборка до рабочей копии, а не посреди неё. Заодно это и
 * единственная загрузка контекста преполёта — остальные проверки получают его готовым.
 */
function loadContext(deps: PreflightDeps, opts: BenchOptions): { check: PreflightCheck; ctx: PreflightContext | null } {
  const started = Date.now();
  const name = 'конфиг: контрольный маршрут';
  try {
    const config = deps.loadConfig();
    const control = readControl(deps.controlFile);
    const built = buildProfile({ projectRoot: deps.benchDir, models: config.models, control, opts });
    return { check: ok(name, true, `маршрут «${control.label}» собирается`, Date.now() - started), ctx: { config, control, built } };
  } catch (e) {
    return { check: bad(name, true, (e as Error).message, Date.now() - started), ctx: null };
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
 * Зелёность фикстуры: `scripts/build-check.mjs` (если есть) и тесты фикстуры. Ожидаемый цвет
 * набора — `fixtureColorOf` (tasks.ts): намеренно красная (`broken-assert`) инвертирует
 * проверку — зелёная там значит, что задача потеряла предмет; мигающая (`flaky-test`) цвет
 * не проверяет вовсе — один прогон мигающего набора не говорит ничего.
 */
async function checkFixture(deps: PreflightDeps, opts: BenchOptions): Promise<PreflightCheck[]> {
  const name = 'фикстура';
  const def = taskById(opts.task);
  const fixtureDir = join(deps.benchDir, def.fixtureDir);
  const color = fixtureColorOf(def);

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

  // Мигающий набор не гоняется: зелёный прогон читался как «задача потеряла предмет», и
  // автогейт давал код 2 примерно в 60 % запусков законного прогона (выборка 3 из 5).
  if (color === 'flaky') {
    return [...checks, ok(`${name}: тесты`, true, 'набор фикстуры мигает по дизайну — цвет одного прогона ничего не говорит, не проверяется')];
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
  if (color === 'red') {
    return green
      ? [...checks, bad(`${name}: тесты`, true, 'фикстура ЗЕЛЁНАЯ, а задача ждёт намеренно красную — чинить больше нечего', ms)]
      : [...checks, ok(`${name}: тесты`, true, 'намеренно красная фикстура подтверждена красной', ms)];
  }
  return green
    ? [...checks, ok(`${name}: тесты`, true, `нетронутая фикстура зелёная (${tests.length} файлов)`, ms)]
    : [...checks, bad(`${name}: тесты`, true, `нетронутая фикстура КРАСНАЯ (код ${r.exitCode}) — прогон измерит битую среду, а не модель`, ms)];
}

/**
 * Снимок `--from-snapshot`: существование, мета и принадлежность задаче — той же проверкой,
 * что у восстановления (`readSnapshotMeta`), — и есть ли что мерить ПОСЛЕ точки снимка.
 *
 * Первый измеряемый этап считается от этапа старта драйвера (`startStageAfter`), а не с
 * начала витка: при `--all` первым измеряемым был бы intent, и любой снимок давал «нечего
 * мерить» и код 2 на законном `--all --from-snapshot`.
 */
function checkSnapshot(deps: PreflightDeps, opts: BenchOptions): PreflightCheck | null {
  if (opts.fromSnapshot === null) return null;
  const started = Date.now();
  const name = 'снимок';
  let point: string;
  try {
    point = readSnapshotMeta({ snapshotsDir: deps.snapshotsDir, name: opts.fromSnapshot, expectedTask: opts.task }).stoppedAfterStage;
  } catch (e) {
    if (e instanceof SnapshotError) return bad(name, true, e.message, Date.now() - started);
    throw e;
  }
  // Точку `readSnapshotMeta` уже проверил: `null` здесь невозможен.
  const start = startStageAfter(point)!;
  const measured = measuredStages(opts.mode);
  const first = firstMeasuredFrom(start, measured);
  if (first === null) {
    return bad(
      name,
      true,
      `точка снимка «${point}»: все измеряемые этапы (${measured.join(', ')}) снимок уже прошёл — прогону нечего мерить`,
      Date.now() - started,
    );
  }
  return ok(
    name,
    true,
    `снимок «${opts.fromSnapshot}» на месте, задача совпадает; старт с «${start}», первый измеряемый — «${first}»`,
    Date.now() - started,
  );
}

/** Окно контекста измеряемых маршрутов (LM Studio — фактическое, Ollama — зашитое/4096). */
async function checkContextWindows(deps: PreflightDeps, ctx: PreflightContext): Promise<PreflightCheck[]> {
  const name = 'модель: окно контекста';
  const seen = new Set<string>();
  const out: PreflightCheck[] = [];
  for (const stage of ctx.built.measured) {
    const route = ctx.built.profile.routes[stage];
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
async function checkModel(deps: PreflightDeps, config: LoadedConfig, opts: BenchOptions): Promise<PreflightCheck[]> {
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
  const loaded = loadContext(d, opts);
  const checks: PreflightCheck[] = [taskCheck, ...(taskCheck.ok ? [checkAnswerBank(d, opts.task)] : []), loaded.check];
  checks.push(...(await checkFixture(d, opts)));
  const snap = checkSnapshot(d, opts);
  if (snap !== null) checks.push(snap);

  const ctx = loaded.ctx;
  if (ctx !== null && checks.every((c) => c.ok)) {
    checks.push(checkTurnLimit(ctx.config, opts));
    const planFit = checkPlanPromptFits(ctx, opts);
    if (planFit !== null) checks.push(planFit);
    checks.push(...(await checkContextWindows(d, ctx)));
    if (checks.every((c) => c.ok)) {
      checks.push(...(await checkModel(d, ctx.config, opts)));
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
