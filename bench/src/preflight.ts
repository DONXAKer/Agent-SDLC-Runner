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
 * на ответ», `finish_reason: length`). На `--stage verify` набор ДРУГОЙ —
 * `REVIEWER_PROBE_CASES` (`server/src/probe.ts`): `reviewFill` не вызывает ни одного
 * инструмента, и Write/Edit измеряют способности исполнителя chunk, не рецензента
 * (критерий 3 квалификации рецензента, `docs/proposals/reviewer-qualification.md`) —
 * `qwen3.6-27b-iq4` (2026-09-27) прошла старый набор и провалила настоящий `reviewFill`.
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
import { PREFLIGHT_CASES, PROBE_CASE_TIMEOUT_MS, REVIEWER_PROBE_CASES, probeModel, resolveProbeTarget } from '../../server/src/probe.ts';
import type { ProbeCase } from '../../server/src/probe.ts';
import type { ProbeReport } from '../../server/src/probe.ts';
import { contextProblemFor } from '../../server/src/provider/contextCheck.ts';
import type { ContextProblem } from '../../server/src/provider/contextCheck.ts';
import { layoutProblemFor } from '../../server/src/provider/layoutCheck.ts';
import type { LayoutProblem } from '../../server/src/provider/layoutCheck.ts';
import { isLoopbackUrl } from '../../server/src/provider/http.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import { isEngineEnvFailure, reloadEngine, warmupEngine } from './engine.ts';
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
  /** Прогрев движка одним дешёвым запросом (`engine.ts`) — до замеряемых проб. */
  warmup: typeof warmupEngine;
  /** Перезагрузка модели при средовом сбое движка — только за `--engine-reload`. */
  reloadEngine: typeof reloadEngine;
  contextProblem: typeof contextProblemFor;
  /** Раскладка по видеопамяти ПОСЛЕ прогрева — критерий 1 квалификации рецензента, см. `layoutCheck.ts`. */
  layoutProblem: typeof layoutProblemFor;
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
    warmup: warmupEngine,
    reloadEngine,
    contextProblem: contextProblemFor,
    layoutProblem: layoutProblemFor,
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
 * человека и есть предмет измерения, fallback ломает само измерение — серия v4 дала 21 такой
 * вопрос, и видно это было только после прогона. НЕ блокирует: 16 из 30 фикстур на
 * 2026-09-17 несут пустой `rules` НАМЕРЕННО (комментарий «Пусто по дизайну» прямо в файле) —
 * весь ответ добывается из кода/теста/текста задачи, и это большинство, не исключение.
 * Раньше 0 правил било КРАСНЫМ по среде даже для задач, где сама фикстура называет пустой
 * банк своим правильным устройством (`two-right-answers`, `refuse-dangerous`,
 * `silent-contract` и другие — у каждой комментарий «Пусто по дизайну» на месте `rules`),
 * и серия `--all`/`--repeat` на них не стартовала без `--no-preflight`.
 */
function checkAnswerBank(deps: PreflightDeps, task: string): PreflightCheck {
  const started = Date.now();
  const name = 'задача: банк ответов человека';
  const files = taskPaths(deps.benchDir, taskById(task));
  try {
    const script = readHumanScript(files.humanFile);
    const rules = script.answers.rules.length;
    if (rules === 0) {
      return ok(name, true, `правил ответа 0 — каждый вопрос модели уйдёт в fallback; число таких — в отчёте`, Date.now() - started);
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

/** Один маршрут с красным окном, чинимым перезагрузкой движка (`reloadEngine`). */
interface ReloadableRoute {
  provider: string;
  model: string;
  contextWindow?: number;
  baseUrl?: string;
}

interface ContextWindowsResult {
  checks: PreflightCheck[];
  /** Маршруты с `ContextProblem.reloadable === true`, по одному на разный provider/model. */
  reloadable: ReloadableRoute[];
}

/** Окно контекста измеряемых маршрутов (LM Studio — фактическое, Ollama — зашитое/4096). */
async function checkContextWindows(deps: PreflightDeps, ctx: PreflightContext): Promise<ContextWindowsResult> {
  const name = 'модель: окно контекста';
  const seen = new Set<string>();
  const out: PreflightCheck[] = [];
  const reloadable: ReloadableRoute[] = [];
  for (const stage of ctx.built.measured) {
    const route = ctx.built.profile.routes[stage];
    const key = `${route.provider}/${route.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const started = Date.now();
    const problem: ContextProblem | null = await deps.contextProblem(
      route.provider,
      route.model,
      route.contextWindow,
      route.providerDef.baseUrl,
    );
    const ms = Date.now() - started;
    if (problem !== null) {
      out.push(bad(name, true, problem.message, ms));
      if (problem.reloadable) {
        reloadable.push({
          provider: route.provider,
          model: route.model,
          ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
          ...(route.providerDef.baseUrl === undefined ? {} : { baseUrl: route.providerDef.baseUrl }),
        });
      }
    }
  }
  if (out.length === 0) out.push(ok(name, true, 'окна измеряемых маршрутов в порядке (или провайдер без управляемого окна)'));
  return { checks: out, reloadable };
}

/**
 * `checkContextWindows` плюс автоперезагрузка (`--engine-reload`): дыра, пойманная
 * серией local6 (2026-09-24) — `--engine-reload` чинил только сбой ДВИЖКА на прогреве
 * (`checkWarmup`), а красное окно (модель не загружена, загружена не с тем окном или
 * с `parallel>1`) красило преполёт РАНЬШЕ прогрева и до реакции на флаг не доходило:
 * 12 из 18 прогонов серии сгорели именно так, при том что и диагноз, и команда фикса
 * уже были в тексте ошибки.
 *
 * Красные проверки первого прохода ЗАМЕНЯЮТСЯ (не дополняются) результатом повтора —
 * иначе устаревший красный `bad()` остался бы в списке даже после удачной перезагрузки,
 * и `checks.every(c => c.ok)` ниже по `runPreflight` не увидел бы зелёного окна.
 */
async function checkContextWindowsWithReload(
  deps: PreflightDeps,
  ctx: PreflightContext,
  opts: BenchOptions,
): Promise<PreflightCheck[]> {
  const first = await checkContextWindows(deps, ctx);
  if (first.checks.every((c) => c.ok) || first.reloadable.length === 0) return first.checks;
  if (opts.engineReload !== true) return first.checks;

  const done = new Set<string>();
  const outcomes: string[] = [];
  let anyReloaded = false;
  for (const r of first.reloadable) {
    const key = `${r.provider}/${r.model}`;
    if (done.has(key)) continue;
    done.add(key);
    const reload = await deps.reloadEngine({
      provider: r.provider,
      model: r.model,
      ...(r.baseUrl === undefined ? {} : { baseUrl: r.baseUrl }),
      ...(r.contextWindow === undefined ? {} : { contextWindow: r.contextWindow }),
    });
    outcomes.push(`${key}: ${reload.detail}`);
    if (reload.kind === 'reloaded') anyReloaded = true;
  }
  if (!anyReloaded) {
    return [...first.checks, bad('модель: окно контекста (перезагрузка)', true, outcomes.join('; '))];
  }
  const again = await checkContextWindows(deps, ctx);
  return again.checks.map((c) => ({ ...c, name: `${c.name} (после перезагрузки)` }));
}

/**
 * Прогрев движка одним дешёвым запросом — первый модельный шаг преполёта, ДО замеряемых
 * проб (`engine.ts::warmupEngine`). Холодный движок (LM Studio / ollama) поднимает веса на
 * первом вызове, и без прогрева этот холодный старт ложился в первую пробу и мерил движок,
 * а не модель. Длительность попадает в отчёт как у любой проверки — по ней холодный старт
 * и читается.
 *
 * Сбой ДВИЖКА на прогреве — средовый (⛔, код 2): на один токен не отвечает только
 * лёгший/холодный движок, и гонять дальше семь кейсов по 120 с бессмысленно — проба не
 * запускается. При таком сбое (та же классификация, что у провайдера — `isEngineEnvFailure`)
 * и ЯВНОМ `--engine-reload` — ОДНА попытка перезагрузки и один повтор: GPU общий, поэтому
 * без флага преполёт ограничивается диагнозом и подсказкой, а повтор после перезагрузки —
 * ровно один, второй серии не будет.
 *
 * Прочий сбой прогрева (400 на `max_tokens: 1` у провайдера с порогом, кривой параметр)
 * преполёт не красит: прогрев — не замер, и его ошибку классифицирует проба тем же
 * запросом с настоящими параметрами. Прежде такой сбой красил «средой» (код 2) и не давал
 * стартовать маршруту, на котором проба прошла бы (code-review-all 2026-09-23). Облачные
 * провайдеры не прогреваются вовсе: холодных весов у них нет.
 */
async function checkWarmup(
  deps: PreflightDeps,
  config: LoadedConfig,
  opts: BenchOptions,
): Promise<{ check: PreflightCheck | null; reloaded: boolean }> {
  const name = 'модель: прогрев движка';
  const target = resolveProbeTarget(config.models, opts.model);
  // Цель не разрешилась (sdk-флоу, битый конфиг) — диагноз назовёт проба ниже,
  // дублировать его строкой прогрева незачем.
  if ('error' in target) {
    return { check: ok(name, true, 'цель пробы не разрешилась — прогрев пропущен, диагноз назовёт проба'), reloaded: false };
  }
  const { def, providerDef } = target;
  if (!isLocalEngine(def.provider, providerDef)) return { check: null, reloaded: false };
  const provider = createProvider(def.provider, providerDef, config.runner.limits.chatTimeoutMs);
  const args = { provider, model: def.model, params: def.params ?? null };
  const noReload = (check: PreflightCheck) => ({ check, reloaded: false });

  const started = Date.now();
  try {
    await deps.warmup(args);
    return noReload(ok(name, true, 'движок ответил — веса подняты до замеряемых проб', Date.now() - started));
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    const ms = Date.now() - started;
    if (!isEngineEnvFailure(e)) {
      return noReload(ok(name, false, `прогрев не удался не по движку: ${message} — классифицирует проба`, ms));
    }
    if (opts.engineReload !== true) {
      return noReload(
        bad(
          name,
          true,
          `движок не ответил на прогрев: ${message}; перезагрузить движок и повторить прогрев может преполёт с явным --engine-reload`,
          ms,
        ),
      );
    }
    const reload = await deps.reloadEngine({
      provider: def.provider,
      model: def.model,
      ...(providerDef.baseUrl === undefined ? {} : { baseUrl: providerDef.baseUrl }),
      ...(def.contextWindow === undefined ? {} : { contextWindow: def.contextWindow }),
    });
    if (reload.kind !== 'reloaded') {
      return noReload(bad(name, true, `движок не ответил на прогрев: ${message}; ${reload.detail}`, ms));
    }
    const retryStarted = Date.now();
    try {
      await deps.warmup(args);
      return {
        check: ok(name, true, `движок поднялся после перезагрузки (${reload.detail})`, ms + (Date.now() - retryStarted)),
        reloaded: true,
      };
    } catch (e2) {
      const message2 = (e2 instanceof Error ? e2.message : String(e2)).slice(0, 200);
      return {
        check: bad(
          name,
          true,
          `перезагрузка выполнена (${reload.detail}), но движок не ответил и на повтор: ${message2}`,
          ms + (Date.now() - retryStarted),
        ),
        reloaded: true,
      };
    }
  }
}

/**
 * Раскладка модели по видеопамяти — ТОЛЬКО после успешного прогрева: без него веса ещё не
 * загружены, и раскладку смотреть не на чем. Критерий 1 квалификации рецензента
 * (`docs/proposals/reviewer-qualification.md`): частичный CPU-офлоад проходит короткие
 * изолированные кейсы `--probe` (40–110 с) и вскрывается только настоящей нагрузкой —
 * `qwen3.6-27b-iq4` (2026-09-27) прошла пробу 3/3 и зависла на реальном `reviewFill`
 * именно по этой причине (`ollama ps`: 26%/74% CPU/GPU). Реализовано только для Ollama —
 * см. `layoutCheck.ts`; на прочих провайдерах молча пропускается (`check: null`), не красит.
 */
async function checkLayout(deps: PreflightDeps, config: LoadedConfig, opts: BenchOptions): Promise<PreflightCheck | null> {
  const name = 'модель: раскладка после прогрева';
  const target = resolveProbeTarget(config.models, opts.model);
  if ('error' in target) return null;
  const { def, providerDef } = target;
  // Реализовано только для Ollama — на прочих провайдерах строка не показывается вовсе,
  // а не «зелёная по умолчанию»: непроверенное не должно выглядеть проверенным.
  if (def.provider !== 'ollama') return null;

  const started = Date.now();
  const problem: LayoutProblem | null = await deps.layoutProblem(
    def.provider,
    def.model,
    providerDef.baseUrl,
    config.runner.limits.chatTimeoutMs,
  );
  const ms = Date.now() - started;
  return problem === null
    ? ok(name, false, 'ollama ps: раскладка в порядке (модель целиком в видеопамяти) или сама проверка неприменима', ms)
    : bad(name, true, problem.message, ms);
}

/**
 * Локальный движок с холодными весами — прогрев и перезагрузка имеют смысл только у него.
 * Известные локальные провайдеры по имени — и любой openai-совместимый провайдер на адресе
 * этой машины: провайдер, заведённый под другим именем (`lmstudio2`), иначе молча терял
 * прогрев (code-review-all 2026-09-23).
 */
const LOCAL_ENGINES: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'vllm']);

function isLocalEngine(provider: string, def: { kind: string; baseUrl?: string }): boolean {
  if (LOCAL_ENGINES.has(provider)) return true;
  return def.kind === 'openai-compat' && def.baseUrl !== undefined && isLoopbackUrl(def.baseUrl);
}

/**
 * Модельные кейсы пробы — только флоу loop; sdk-флоу проба не меряет (resolveProbeTarget).
 *
 * Модельный провал кейса перезапускается ОДИН раз: ночные серии test24/test24c
 * (docs/model-runs.md) показали, что одиночный ❌ шумной пробы («правка поля без
 * перезаписи файла» у трёх моделей, проходивших её накануне) — слабый сигнал отсева,
 * а красил весь преполёт и отменял долгий прогон. Вторая попытка зелёная — кейс
 * засчитан, но с пометкой «со 2-й попытки», чтобы шумность не терялась из отчётов.
 * Средовой сбой (⛔) НЕ перезапускается: там таймауты по 120 с, ретрай дорог и
 * измерял бы среду, а не модель.
 */
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
  // Роль решает набор кейсов — см. докстринг `REVIEWER_PROBE_CASES` (`probe.ts`) и
  // критерий 3 квалификации рецензента (`docs/proposals/reviewer-qualification.md`).
  // `--all` verify не меряет (см. `BenchMode`), поэтому проверяется только `stage`.
  const forReviewer = opts.mode.kind === 'stage' && opts.mode.stage === 'verify';
  const cases: readonly ProbeCase[] = forReviewer ? REVIEWER_PROBE_CASES : PREFLIGHT_CASES;
  // `role` — часть общего `probeArgs`, а не отдельный параметр только первого вызова:
  // retry одного кейса ниже (`deps.probe({ ...probeArgs, cases: [retryCase] })`) передаёт
  // НОВЫЙ массив из одного элемента, и вывод роли по ссылочному равенству с
  // `REVIEWER_PROBE_CASES` на этом retry молча откатывался к `'chunk'` (code-review-all,
  // 2026-09-28) — `role` в `probeArgs` избавляет от второго места, где это можно забыть.
  const probeArgs = {
    provider,
    model: def.model,
    params: def.provider === 'lmstudio'
      ? { ...(def.params ?? {}), reasoning_effort: def.params?.['reasoning_effort'] ?? 'none' }
      : def.params ?? null,
    caseTimeoutMs: opts.probeTimeoutMs ?? PROBE_CASE_TIMEOUT_MS,
    role: (forReviewer ? 'verify' : 'chunk') as 'chunk' | 'verify',
  };
  const report: ProbeReport = await deps.probe({ ...probeArgs, cases });
  const toCheck = (c: ProbeReport['cases'][number], detail = c.detail, durationMs = c.durationMs): PreflightCheck => ({
    name: `модель: ${c.name}`,
    ok: c.ok,
    env: c.env,
    detail,
    durationMs,
  });

  const checks: PreflightCheck[] = [];
  for (const c of report.cases) {
    // Таймаут кейса (`timedOut`) — измерение о модели (красит кодом 1, не 2 — `env` уже
    // `false`), но повтор бессмыслен: он удвоил бы тот же потолок без нового сигнала
    // (найдено серией local6, 2026-09-24 — apriel-1.6-15b, 120–218 с на кейс).
    if (c.ok || c.env || c.timedOut) {
      checks.push(toCheck(c, c.timedOut ? `${c.detail} — попробуй больший --probe-timeout, если это разовая нагрузка` : c.detail));
      continue;
    }
    const retryCase = cases.find((p) => p.name === c.name);
    if (retryCase === undefined) {
      checks.push(toCheck(c));
      continue;
    }
    const second: ProbeReport = await deps.probe({ ...probeArgs, cases: [retryCase] });
    const r = second.cases[0];
    if (r === undefined) {
      checks.push(toCheck(c));
    } else if (r.ok) {
      checks.push(toCheck({ ...c, ok: true }, `${r.detail} (со 2-й попытки)`, c.durationMs + r.durationMs));
    } else if (r.env) {
      // Повтор упал средой — модель по этому кейсу не измерена, а не провалена:
      // красим как средовый сбой (код 2), иначе транзиентный транспорт снова
      // вычеркнул бы модель одиночным шумным сигналом.
      checks.push(
        toCheck(
          { ...c, env: true },
          `1-я попытка — провал модели (${c.detail}); повтор не измерен: ${r.detail}`,
          c.durationMs + r.durationMs,
        ),
      );
    } else {
      checks.push(toCheck(c, `${r.detail} (провал в 2/2 попыток)`, c.durationMs + r.durationMs));
    }
  }
  return checks;
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
    checks.push(...(await checkContextWindowsWithReload(d, ctx, opts)));
    if (checks.every((c) => c.ok)) {
      const warm = await checkWarmup(d, ctx.config, opts);
      if (warm.check !== null) checks.push(warm.check);
      // Перезагрузка подняла модель заново — окно и слоты, проверенные ДО неё, уже не про
      // эту загрузку: перепроверяются, иначе урезанное окно прошло бы преполёт зелёным.
      if (warm.reloaded && checks.every((c) => c.ok)) {
        const again = await checkContextWindows(d, ctx);
        checks.push(...again.checks.map((c) => ({ ...c, name: `${c.name} (после перезагрузки)` })));
      }
    }
    if (checks.every((c) => c.ok)) {
      const layout = await checkLayout(d, ctx.config, opts);
      if (layout !== null) checks.push(layout);
    }
    if (checks.every((c) => c.ok) && opts.executionMode !== 'guided') {
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
