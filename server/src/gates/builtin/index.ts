/**
 * Встроенные реализации обязательного минимума.
 *
 * Строка набора говорит, ЧЕМ гейт реализован. Если там команда — рантайм выполняет её.
 * Если там проза («скрипт сверки diff с files_to_touch»), рантайм берёт встроенную
 * реализацию: проект описал намерение, а исполнитель у намерения один и тот же.
 *
 * Встроенный гейт различает три исхода — `✅`, `❌` и `⏭`. Третий не «почти прошёл»:
 * `⏭` роняет вердикт, если человек не подписал неприменимость. Поэтому «нечем собрать»
 * печатается честно, а не выдаётся за зелёный — гейт, который врёт, приучает игнорировать
 * себя.
 */

import { worstGateStatus } from '@sdlc-runner/shared';
import {
  CODE_EXTENSIONS,
  ORDER,
  detectBuildSystem,
  detectEcosystem,
  syntaxCheckerFor,
} from '../ecosystems/index.ts';
import { normalizePlanPath, toPosix } from '../../policy/paths.ts';
import { addedFunctionNames, findDuplicates } from './duplicates.ts';
import { extractHumanFacts, literalPattern } from '../../artifacts/humanFacts.ts';
import type { BuildSystem } from '../ecosystems/index.ts';
import type { ModuleProfile } from '../../config/schema.ts';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { GateStatus } from '@sdlc-runner/shared';

import { changedPaths, currentBranch, deletedPaths, git, hasCommits, isRepo, workingDiff } from '../git.ts';
import { gateKey } from '../gatesFile.ts';
import { runShell } from '../shell.ts';
import type { InvariantViolation } from './logic.ts';
import {
  diffLines,
  invariantViolations,
  moduleDirsFromPlan,
  normalizeModuleDir,
  publishProblems,
  scopeViolations,
} from './logic.ts';

export interface GateContext {
  projectRoot: string;
  /**
   * Модули, описанные человеком в конфиге проекта. Пусто — работает автодетект.
   * Приоритет: команда из `.sdlc/gates.md` > это описание > детект.
   */
  modules?: readonly ModuleProfile[];
  /** Сколько модулей проверять одновременно. По умолчанию 1 — последовательно. */
  moduleParallel?: number;
  /** `files_to_touch` одобренного плана — вход scope-гейта и детекта модуля. */
  planFiles: readonly string[];
  /**
   * Путь к clarification-report.md текущего витка — вход гейта «Ответы человека в коде».
   * Опционален: слаг витка знает рантайм, а не набор гейтов; без пути гейт честно
   * говорит, что проверять нечего.
   */
  clarificationPath?: string;
  /** Снимок грязного дерева до этапа 5: путь → хеш. `null` — снимка нет. */
  baseline: ReadonlyMap<string, string> | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BuiltinOutcome {
  status: GateStatus;
  command: string | null;
  exitCode: number | null;
  lastLine: string;
  /**
   * Гейт не смог ЗАПУСТИТЬСЯ по причине, лежащей в машине: нет инструмента, нет
   * зависимостей, нет docker'а. Умолчание — `false`, и это важно: «проверять нечего»
   * (`⏭` без плана, без git-репозитория, без изменённых файлов) средой НЕ является —
   * это дефект набора или конфигурации, чинится правкой, а не другой машиной.
   *
   * Признак ставит тот, кто знает причину. Прежде он выводился снаружи эвристикой
   * `⏭ && exitCode === null`, и она метила как «поломку машины» находку «похоже на
   * переписанный хелпер — нужен ответ человека», а настоящий сбой git — не метила.
   */
  envBlocked?: boolean;
  /**
   * Хвост фактического вывода команды — для свидетельства попытки (`…-tests.txt`).
   *
   * Без него запись рантайма несла только сводку «4 failed, 149 passed», и исполнитель
   * следующей попытки чинил тесты ВСЛЕПУЮ: имена упавших и трейсбеки не были видны ни
   * ему, ни рецензенту (наблюдалось на живом витке — попытка 2 не сдвинула счёт падений).
   * В строку гейта (`lastLine`) хвост не идёт — там сводка; полный вывод только в улике.
   */
  outputTail?: string;
}

/** Хвост вывода для улики: последние строки, с потолком по байтам. */
export function outputTailOf(stdout: string, stderr: string, maxLines = 200, maxBytes = 20000): string {
  // Метка stderr ставится ПЕРЕД его содержимым и когда stdout пуст: иначе stderr читался
  // неотличимо от stdout, и улика молча выдавала диагностику за штатный вывод.
  const joined = [
    ...(stdout.trim() === '' ? [] : [stdout]),
    ...(stderr.trim() === '' ? [] : [`--- stderr ---\n${stderr}`]),
  ].join('\n');
  const lines = joined.split(/\r?\n/);
  let tail = lines.slice(-maxLines).join('\n');
  let cutBytes = false;
  if (Buffer.byteLength(tail, 'utf8') > maxBytes) {
    tail = Buffer.from(tail, 'utf8').subarray(-maxBytes).toString('utf8');
    // Байтовый срез мог попасть в середину UTF-8-символа — обрывок в начале не текст.
    tail = tail.replace(/^�+/, '');
    cutBytes = true;
  }
  // Любая обрезка называется вслух: молча усечённая улика читается как полная, и
  // рецензент судит по неполному выводу, не зная об этом.
  const marks = [
    ...(lines.length > maxLines ? [`показаны последние ${maxLines} строк`] : []),
    ...(cutBytes ? [`хвост урезан до ${maxBytes} байт`] : []),
  ];
  return marks.length > 0 ? `[рантайм обрезал: ${marks.join('; ')}]\n${tail}` : tail;
}

export type BuiltinGate = (ctx: GateContext) => Promise<BuiltinOutcome>;

function dirEntries(root: string, dir: string): Set<string> {
  const full = dir === '.' ? root : join(root, dir);
  try {
    return new Set(readdirSync(full));
  } catch {
    return new Set();
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Описание модуля из конфига проекта для этого каталога. `null` — не описан. */
function declaredModule(ctx: GateContext, dir: string): ModuleProfile | null {
  const want = normalizeModuleDir(dir);
  return (ctx.modules ?? []).find((m) => normalizeModuleDir(m.dir) === want) ?? null;
}

/**
 * Как рантайм видит сборку проекта — для промпта.
 *
 * Источник тот же, что у гейтов: описание модулей проекта, иначе автодетект. Второй детект
 * на стороне сборки промпта означал бы два знания об одном, и однажды они разошлись бы —
 * промпт обещал бы одну команду, а гейт прогонял другую.
 */
export function describeBuild(
  ctx: GateContext,
): { dir: string; label: string; build: string | null; test: string | null }[] {
  const out: { dir: string; label: string; build: string | null; test: string | null }[] = [];
  for (const mod of resolveModules(ctx)) {
    const system = resolveCommands(ctx, mod.dir, mod.files);
    if (system === null) continue;
    const declaredId = declaredModule(ctx, mod.dir)?.ecosystem;
    const eco =
      declaredId === undefined
        ? detectEcosystem(mod.files)
        : (ORDER.find((e) => e.id === declaredId) ?? null);
    out.push({
      dir: mod.dir,
      // Экосистема может не определиться, когда команда задана человеком напрямую: это не
      // повод молчать про команду, но и выдумывать имя языка не надо.
      label: eco?.label ?? 'команда задана в конфиге проекта',
      build: system.build,
      test: system.test,
    });
  }
  return out;
}

/**
 * Проход по модулям. По умолчанию ПОСЛЕДОВАТЕЛЬНЫЙ.
 *
 * Довод из `runGates` («гейты делят рабочее дерево, git-индекс и память») параллельные
 * сборки разных модулей не отменяет: gradle-демон и `npm ci` конкурируют за диск и память,
 * а тесты могут делить порт или базу. Параллельность включается лимитом в конфиге и должна
 * оправдываться замером, а не ощущением.
 */
async function forEachModule(
  ctx: GateContext,
  mods: readonly { dir: string; files: Set<string> }[],
  run: (m: { dir: string; files: Set<string> }) => Promise<BuiltinOutcome>,
): Promise<{ dir: string; outcome: BuiltinOutcome }[]> {
  const width = Math.max(1, ctx.moduleParallel ?? 1);
  return inBatches(mods, width, async (m) => ({ dir: m.dir, outcome: await run(m) }));
}

/**
 * Get-or-compute по контексту прогона — общий паттерн `modulesCache`/`diffCache`/
 * `rawDiffCache` ниже: `WeakMap` по идентичности `ctx` живёт и умирает вместе с прогоном
 * (`gates/run.ts` создаёт контекст один раз на прогон), сбрасывать нечего и забыть сброс
 * невозможно. Работает и для синхронных значений, и для `Promise<T>` — кэш в последнем
 * случае хранит САМ промис (а не его результат), что заодно схлопывает конкурентные вызовы
 * в один запрос вместо параллельных дублей.
 */
function memoByCtx<T>(cache: WeakMap<GateContext, T>, ctx: GateContext, compute: () => T): T {
  const cached = cache.get(ctx);
  if (cached !== undefined) return cached;
  const value = compute();
  cache.set(ctx, value);
  return value;
}

/**
 * Тот же приём, но для `Promise<T>`-кэшей: кэш обязан хранить промис ДО его резолва (иначе
 * конкурентные вызовы не схлопнутся в один запрос), но если он зарежектится — запись нужно
 * убрать, а не оставлять reject висеть в `WeakMap` на весь прогон. Простой `memoByCtx` этого
 * не делает: транзиентный сбой `git` (лок репозитория, убитый процесс) на первом гейте,
 * вызвавшем кэшируемую функцию, иначе мгновенно валил бы ВСЕ последующие гейты того же
 * набора тем же самым исключением, без единого шанса на повтор.
 */
function memoByCtxAsync<T>(
  cache: WeakMap<GateContext, Promise<T>>,
  ctx: GateContext,
  compute: () => Promise<T>,
): Promise<T> {
  return memoByCtx(cache, ctx, () =>
    compute().catch((e: unknown) => {
      cache.delete(ctx);
      throw e;
    }),
  );
}

/**
 * Кэш `resolveModules` по контексту прогона: «Сборка», «Тесты» и «Линт» из одного набора
 * зовут `resolveModules` с ОДНИМ и тем же `ctx`, и без кэша каждая из трёх заново парсила
 * план и перечитывала каталоги модулей `readdirSync`'ом — тот же файл диска, трижды подряд,
 * за один прогон гейтов.
 *
 * Работает только для этого пути (`runGates`/гейты этапа 6) — `describeBuild`, вызываемый
 * из `Run.ts::preparePrompt` для сборки промпта, строит СВОЙ `GateContext`-литерал на
 * каждый вызов (не переиспользует ссылку), поэтому кэш по идентичности `ctx` для него
 * гарантированно промахивается: не оптимизация для этого конкретного вызывающего, только
 * для гейтов.
 */
const modulesCache = new WeakMap<GateContext, { dir: string; files: Set<string> }[]>();

/** Все модули, затронутые планом. Пусто — собирать нечего. */
function resolveModules(ctx: GateContext): { dir: string; files: Set<string> }[] {
  return memoByCtx(modulesCache, ctx, () => {
    const dirs = moduleDirsFromPlan(ctx.planFiles, (d) => {
      // Объявленный человеком модуль — модуль, даже если манифеста детект не знает: ради
      // этого случая поле и заводилось.
      if (declaredModule(ctx, d) !== null) return true;
      const files = dirEntries(ctx.projectRoot, d);
      return detectBuildSystem(files, readIfExists(join(ctx.projectRoot, d, 'package.json'))) !== null;
    });
    return dirs.map((dir) => ({ dir, files: dirEntries(ctx.projectRoot, dir) }));
  });
}

/**
 * Сводит исходы по модулям в один статус гейта по правилу «худший побеждает».
 *
 * `✅` только если проверены ВСЕ модули: гейт, зеленеющий по одному из двух затронутых, —
 * ровно тот ложный зелёный, ради устранения которого прогон и разложен по модулям.
 * Правило берётся из общего пакета, второй его копии здесь нет.
 */
function aggregate(
  parts: readonly { dir: string; outcome: BuiltinOutcome }[],
  fallback: BuiltinOutcome,
): BuiltinOutcome {
  if (parts.length === 0) return fallback;
  if (parts.length === 1) {
    const only = parts[0];
    return only === undefined ? fallback : only.outcome;
  }

  const status = parts.reduce<GateStatus>((acc, p) => worstGateStatus(acc, p.outcome.status), '✅');
  const failed = parts.filter((p) => p.outcome.status !== '✅');
  return {
    status,
    // Команда у модулей разная, поэтому в поле — перечень: «Сборка ❌» без имени модуля
    // в моно-репо не диагностична.
    command: parts.map((p) => `${p.dir}: ${p.outcome.command ?? 'без команды'}`).join('; '),
    exitCode: failed.find((p) => p.outcome.exitCode !== null)?.outcome.exitCode ?? null,
    lastLine: [
      `модулей проверено: ${parts.length}`,
      ...parts.map((p) => `  ${p.outcome.status} ${p.dir}: ${p.outcome.lastLine}`),
    ].join('\n'),
    // Хвосты модулей склеиваются с заголовками: улика моно-репо обязана говорить, чей вывод.
    ...(parts.some((p) => p.outcome.outputTail !== undefined)
      ? {
          outputTail: parts
            .filter((p) => p.outcome.outputTail !== undefined)
            .map((p) => `=== ${p.dir} ===\n${p.outcome.outputTail}`)
            .join('\n\n'),
        }
      : {}),
  };
}

/**
 * Команды модуля с фиксированным приоритетом источников: описание проекта > автодетект.
 *
 * Команда из `.sdlc/gates.md` сюда не доходит вовсе — она перехватывается раньше, в
 * `runGates`: строка набора исполняется как есть, встроенная реализация тогда не
 * вызывается. Продолжение уже действующего правила «проект, назвавший свою команду,
 * знает про себя больше, чем детект».
 */
function resolveCommands(ctx: GateContext, dir: string, files: ReadonlySet<string>): BuildSystem | null {
  const detected = detectBuildSystem(files, readIfExists(join(ctx.projectRoot, dir, 'package.json')));
  const declared = declaredModule(ctx, dir);
  if (declared === null) return detected;

  const eco = declared.ecosystem === undefined
    ? null
    : (ORDER.find((e) => e.id === declared.ecosystem) ?? null);
  const base = eco?.commands({ files, packageJson: readIfExists(join(ctx.projectRoot, dir, 'package.json')) }) ?? detected;

  // `test: null` в описании — утверждение «раннера нет намеренно», и детект его не
  // перекрывает. Поэтому проверяется наличие ключа, а не истинность значения.
  const test = 'test' in declared ? (declared.test ?? null) : (base?.test ?? null);
  const build = declared.build ?? base?.build;
  if (build === undefined) return null;

  return { build, test, depsDir: base?.depsDir ?? null };
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

const JS_FILE = /\.(js|cjs|mjs)$/i;

/** Сколько процессов `node --check` держим одновременно. */
const NODE_CHECK_PARALLEL = 8;
/** Потолок на один файл: `node --check` — миллисекунды, всё сверх — зависший процесс. */
const NODE_CHECK_TIMEOUT_MS = 10_000;

/** `node --check` одним процессом на файл, путь — аргументом, а не текстом команды. */
/**
 * Запуск проверки синтаксиса одним чекером экосистемы.
 *
 * `noTool` отделяет «интерпретатора нет на машине» от «файл не разбирается»: без этого
 * отсутствие python на машине оператора выглядело бы как синтаксическая ошибка во всех
 * его файлах — красный гейт по несуществующей причине.
 */
interface ProcOutcome {
  code: number | null;
  /** stderr и stdout вместе: линтеры пишут находки то туда, то сюда. */
  output: string;
  noTool: boolean;
  /** Отмена оператором или свой таймаут — НЕ вывод проверки. */
  aborted: boolean;
  timedOut: boolean;
}

function runSyntaxCheck(
  cmd: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; cwd?: string; timeoutMs?: number } = {},
): Promise<ProcOutcome> {
  const limit = opts.timeoutMs ?? NODE_CHECK_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      windowsHide: true,
      // Каталог модуля, а не каталог серверного процесса. Без `cwd` линтер целевого
      // проекта стартовал в репозитории самого раннера: относительная команда
      // (`vendor/bin/phpcs`) не находилась, а `golangci-lint run ./...` честно проверял
      // ЧУЖОЙ проект и возвращал 0 — зелёный гейт про непроверенный код.
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const out: string[] = [];
    let settled = false;
    let timedOut = false;
    const done = (r: ProcOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Без своего потолка гейт «Сборка» висел бы до таймаута всего этапа: у `node --check`
    // собственного лимита нет, а процесс, севший на блокировке файла (антивирус, сетевой
    // диск), не закроется сам.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      done({
        code: null,
        output: `${cmd} не уложился в ${limit} мс`,
        noTool: false,
        aborted: false,
        timedOut: true,
      });
    }, limit);
    timer.unref?.();

    child.stderr.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    // stdout читается наравне со stderr: eslint, ruff и golangci-lint печатают находки
    // именно туда, и без него гейт краснел с формулировкой «линтер сообщил о нарушениях»
    // и пустым выводом — оператор видел красный и не знал, что чинить.
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.on('error', (e) => {
      // Отмена приходит сюда же, что и настоящая ошибка запуска. Без разделения нажатая
      // оператором отмена превращалась в «синтаксическая ошибка — файл не загрузится» на
      // файлах, которые никто не дочитал.
      const aborted = (e as NodeJS.ErrnoException).name === 'AbortError';
      done({
        code: null,
        output: e.message,
        noTool: (e as NodeJS.ErrnoException).code === 'ENOENT',
        aborted,
        timedOut: false,
      });
    });
    child.on('close', (code) =>
      done({ code, output: out.join(''), noTool: false, aborted: false, timedOut }),
    );
  });
}

/** Прогоняет задачи пачками по `size`: без потолка на витке с сотней файлов рождается сотня процессов. */
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Запасная проверка синтаксиса, когда полноценно собрать нечем.
 *
 * «Нечем собрать» не равно «нечего проверить»: `node --check` ловит незакрытую скобку
 * мгновенно, а без него гейт печатал `SKIPPED` и пропускал файл, который вообще не
 * загружается. ESM и JSX отсеиваются по фактическому тексту ошибки, а не грепом по
 * содержимому: `node --check` на `.js` с `import` возвращает 0 даже для битого файла,
 * на `.mjs` работает корректно, а греп на JSX ловил `</div>` в комментарии.
 *
 * Зелёного эта ветка не даёт НИКОГДА: синтаксис — не сборка.
 */
async function syntaxOnly(ctx: GateContext, why: string): Promise<BuiltinOutcome> {
  // Файлы берутся все изменённые, а чекер подбирается по расширению из реестра экосистем:
  // раньше здесь был жёсткий фильтр по `.js/.cjs/.mjs`, и правка на Python или Go молча
  // не проверялась ничем, хотя дешёвая проверка для них существует.
  const changed = await changedPaths(ctx.projectRoot, ctx.signal);
  const targets = changed
    .map((f) => ({ f, eco: syntaxCheckerFor(f) }))
    .filter(
      (t): t is { f: string; eco: NonNullable<ReturnType<typeof syntaxCheckerFor>> } =>
        t.eco !== null && existsSync(join(ctx.projectRoot, t.f)),
    );

  if (targets.length === 0) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${why} — КОМПИЛЯЦИЯ НЕ ПРОВЕРЯЛАСЬ, проверять синтаксисом тоже нечего`,
    };
  }

  // Проверки независимы, поэтому идут пачками: последовательный запуск поднимал процесс
  // на каждый файл (≈96 мс на файл, ~4 с на сорок) прямо на критическом пути оператора, а
  // разом — рождал по процессу на каждый изменённый файл, и на витке, затронувшем сотню,
  // машина уходила в своп. Путь передаётся аргументом, а не вклеивается в строку команды.
  const outcomes = await inBatches(targets, NODE_CHECK_PARALLEL, async (t) => {
    const { cmd, args } = t.eco.syntaxCheck!(join(ctx.projectRoot, t.f));
    return {
      ...t,
      cmd,
      r: await runSyntaxCheck(cmd, args, {
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        cwd: ctx.projectRoot,
      }),
    };
  });

  const bad: string[] = [];
  const usedTools = new Set<string>();
  const missingTools = new Set<string>();
  let checked = 0;
  let skipped = 0;

  for (const { f, eco, cmd, r } of outcomes) {
    if (r.noTool) {
      // Инструмента нет на машине — это не приговор файлу. Считаем непроверенным.
      missingTools.add(cmd);
      skipped++;
      continue;
    }
    if (r.code === 0) {
      usedTools.add(cmd);
      checked++;
      continue;
    }
    // Отмена оператором и свой таймаут — не приговор файлу, а отсутствие проверки. Пока
    // они попадали сюда наравне с ненулевым кодом, нажатая «отмена» рисовала красный гейт
    // с формулировкой «синтаксическая ошибка — файл не загрузится» на непрочитанном файле.
    if (r.aborted || r.timedOut) {
      skipped++;
      continue;
    }
    // ESM отсеивается по фактическому тексту ошибки, а не грепом по содержимому:
    // `node --check` на `.js` с `import` возвращает 0 даже для битого файла, на `.mjs`
    // работает корректно, а греп на JSX ловил `</div>` в комментарии. К другим
    // экосистемам это не относится — проверка привязана к node.
    // TypeScript сюда больше не доходит: `syntaxCheckExt` в реестре не отдаёт `.ts`
    // чекеру, который его не разбирает.
    if (
      eco.id === 'node' &&
      /Cannot use import statement outside a module|Unexpected token '(export|<)'|Unexpected token </.test(
        r.output,
      )
    ) {
      skipped++;
      continue;
    }
    usedTools.add(cmd);
    checked++;
    bad.push(`  ${f}: ${r.output.split(/\r?\n/).slice(0, 3).join(' ')}`);
  }

  const tools = [...usedTools].join(', ');

  if (bad.length > 0) {
    return {
      status: '❌',
      command: tools,
      exitCode: 1,
      lastLine: `синтаксическая ошибка — файл не загрузится:\n${bad.join('\n')}`,
    };
  }

  const missingNote =
    missingTools.size === 0 ? '' : `; не установлено на машине: ${[...missingTools].join(', ')}`;

  if (checked > 0) {
    // `⏭`, а не `✅`. Разбор файлов парсером — это не сборка: правка со сломанным импортом
    // или падающим require проходит проверку синтаксиса и получала зелёный обязательный
    // гейт «Сборка». Гейт, который врёт, приучает игнорировать себя, поэтому здесь честный
    // пропуск: он роняет вердикт, пока человек не подпишет неприменимость.
    return {
      status: '⏭',
      command: tools,
      exitCode: 0,
      lastLine:
        `СБОРКА НЕ ЗАПУСКАЛАСЬ (${why}). Проверен только синтаксис: файлов ${checked} ` +
        `(не проверено: ${skipped}${missingNote}). Ошибки связывания, типов и импортов не проверены.`,
    };
  }

  return {
    status: '⏭',
    command: null,
    exitCode: null,
    lastLine:
      `${why}; из ${targets.length} изменённых файлов не проверен ни один ` +
      `(не проверено: ${skipped}${missingNote}). СИНТАКСИС НЕ ПРОВЕРЕН.`,
  };
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

/** Сборка одного модуля. Агрегацию делает вызывающий. */
async function buildOne(
  ctx: GateContext,
  mod: { dir: string; files: Set<string> },
): Promise<BuiltinOutcome> {
  const system = resolveCommands(ctx, mod.dir, mod.files);
  if (system === null) return syntaxOnly(ctx, `в ${mod.dir} build-система не обнаружена`);
  // Экосистема без шага сборки (Ruby, PHP) — не повод рапортовать зелёным: проверяем то,
  // что проверить можно, — синтаксис изменённых файлов.
  if (system.build === null) {
    return syntaxOnly(ctx, `у ${mod.dir} шага сборки нет — язык без компиляции`);
  }

  // Без установленных зависимостей команда сборки падает на отсутствующем инструменте, и
  // возврат на доработку отправил бы исполнителя чинить несуществующую поломку кода,
  // спалив попытки. «Нечем собирать» — это не «код не собирается». Каталог зависимостей
  // называет сама экосистема: `node_modules` было вшито сюда и делало проверку npm-only.
  if (system.depsDir !== null && !existsSync(join(ctx.projectRoot, mod.dir, system.depsDir))) {
    return syntaxOnly(ctx, `в ${mod.dir} нет ${system.depsDir}`);
  }

  const r = await runShell(system.build, {
    cwd: join(ctx.projectRoot, mod.dir),
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (r.denied !== null) {
    return { status: '⏭', command: system.build, exitCode: null, lastLine: r.lastLine };
  }
  return {
    status: r.exitCode === 0 ? '✅' : '❌',
    command: system.build,
    exitCode: r.exitCode,
    lastLine: r.timedOut ? `сборка не уложилась в ${ctx.timeoutMs} мс` : r.lastLine,
  };
}

const buildGate: BuiltinGate = async (ctx) => {
  const mods = resolveModules(ctx);
  if (mods.length === 0) return syntaxOnly(ctx, 'build-система не обнаружена');

  const parts = await forEachModule(ctx, mods, (m) => buildOne(ctx, m));
  return aggregate(parts, await syntaxOnly(ctx, 'build-система не обнаружена'));
};

/** Тесты одного модуля. Агрегацию делает вызывающий. */
async function testOne(
  ctx: GateContext,
  mod: { dir: string; files: Set<string> },
): Promise<BuiltinOutcome> {
  const system = resolveCommands(ctx, mod.dir, mod.files);

  // «Раннера нет» и «тесты упали» — разные вещи, и различать их обязательно: первое
  // оставляет пункты приёмки, держащиеся на тесте, НЕПОДТВЕРЖДЁННЫМИ, второе означает
  // сломанный код.
  if (system === null || system.test === null) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine:
        `в ${mod.dir} тест-раннер не обнаружен — ТЕСТЫ НЕ ЗАПУСКАЛИСЬ. Пункты приёмки, ` +
        'проверяемые только тестом, остаются неподтверждёнными.',
      envBlocked: true,
    };
  }
  if (system.depsDir !== null && !existsSync(join(ctx.projectRoot, mod.dir, system.depsDir))) {
    return {
      status: '⏭',
      command: system.test,
      exitCode: null,
      lastLine: `в ${mod.dir} нет ${system.depsDir} — ТЕСТЫ НЕ ЗАПУСКАЛИСЬ (зависимости не установлены)`,
      // Среда: чинится установкой зависимостей, а не правкой кода витка.
      envBlocked: true,
    };
  }

  const r = await runShell(system.test, {
    cwd: join(ctx.projectRoot, mod.dir),
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (r.denied !== null) {
    return { status: '⏭', command: system.test, exitCode: null, lastLine: r.lastLine };
  }
  return {
    status: r.exitCode === 0 ? '✅' : '❌',
    command: system.test,
    exitCode: r.exitCode,
    lastLine: r.timedOut ? `тесты не уложились в ${ctx.timeoutMs} мс` : r.lastLine,
    // Хвост нужен и на зелёном прогоне: «какие тесты прошли» — тоже свидетельство.
    outputTail: outputTailOf(r.stdout, r.stderr),
  };
}

const testGate: BuiltinGate = async (ctx) => {
  const mods = resolveModules(ctx);
  const none: BuiltinOutcome = {
    status: '⏭',
    command: null,
    exitCode: null,
    lastLine:
      'тест-раннер не обнаружен — ТЕСТЫ НЕ ЗАПУСКАЛИСЬ. Пункты приёмки, проверяемые ' +
      'только тестом, остаются неподтверждёнными.',
  };
  if (mods.length === 0) return none;

  const parts = await forEachModule(ctx, mods, (m) => testOne(ctx, m));
  return aggregate(parts, none);
};

function hashOf(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return createHash('md5').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Линт экосистемы: паттерны языка проверкой, а не надеждой на промпт.
 *
 * Три исхода различаются честно и по-разному:
 * - линтера нет на машине (ENOENT) → `⏭` со словами «идиоматичность НЕ проверялась». `⏭`
 *   роняет вердикт, пока человек не подпишет неприменимость, — это и есть нужное
 *   поведение, а не досадный побочный эффект;
 * - линтер отработал и нашёл нарушения → `❌` с хвостом вывода;
 * - чисто → `✅`.
 *
 * Проверяются ТОЛЬКО изменённые файлы там, где инструмент это умеет: гейт на всём
 * репозитории краснеет от чужого долга и обучает игнорировать себя. Где инструмент умеет
 * лишь целиком, это сказано в выводе — чтобы «✅» не читалось как «изменения чисты».
 */
const lintGate: BuiltinGate = async (ctx) => {
  const mods = resolveModules(ctx);
  if (mods.length === 0) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: 'модуль не определён — ЛИНТ НЕ ЗАПУСКАЛСЯ, идиоматичность не проверялась',
    };
  }

  const changed = await changedPaths(ctx.projectRoot, ctx.signal);

  const parts = await forEachModule(ctx, mods, async (mod) => {
    const declaredId = declaredModule(ctx, mod.dir)?.ecosystem;
    const eco =
      declaredId === undefined
        ? detectEcosystem(mod.files)
        : (ORDER.find((e) => e.id === declaredId) ?? null);

    // Переопределение из конфига проекта сильнее пресета — тот же приоритет, что у сборки.
    const override = declaredModule(ctx, mod.dir)?.lint;
    if (override === undefined && eco?.lint === undefined) {
      return {
        status: '⏭' as const,
        command: null,
        exitCode: null,
        lastLine: `для ${mod.dir} общепринятого линтера нет — идиоматичность НЕ проверялась`,
      };
    }

    // Только исходники ЭТОГО языка: линтер, получивший `README.md`, `composer.json` или
    // собственный бинарь из `vendor/bin`, падает с ненулевым кодом, и обязательный гейт
    // краснеет по причине, к коду отношения не имеющей. Когда язык модуля неизвестен,
    // фильтровать нечем — тогда идут все изменённые.
    const codeExt = eco?.codeExt;
    const inModule = changed
      .filter((f) => mod.dir === '.' || f.startsWith(`${mod.dir}/`))
      .filter((f) => {
        if (codeExt === undefined) return true;
        const dot = f.lastIndexOf('.');
        return dot >= 0 && codeExt.includes(f.slice(dot).toLowerCase());
      })
      .map((f) => (mod.dir === '.' ? f : f.slice(mod.dir.length + 1)));
    if (inModule.length === 0) {
      return {
        status: '⏭' as const,
        command: null,
        exitCode: null,
        lastLine: `в ${mod.dir} изменённых файлов нет — линтовать нечего`,
      };
    }

    const cwd = join(ctx.projectRoot, mod.dir);

    // Команда из конфига — через шелл, ровно как `build` и `test` того же конфига. Пока
    // она уходила в `spawn` целой строкой, любая настоящая команда с пробелом
    // (`npm run lint`, `ruff check .`) давала ENOENT и вечное «⏭ линтер не найден на
    // машине»: сообщение отправляло чинить установку инструмента, который не запускали.
    if (override !== undefined) {
      const r = await runShell(override, {
        cwd,
        timeoutMs: ctx.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      if (r.denied !== null) {
        return { status: '⏭' as const, command: override, exitCode: null, lastLine: r.lastLine };
      }
      return {
        status: r.exitCode === 0 ? ('✅' as const) : ('❌' as const),
        command: override,
        exitCode: r.exitCode,
        lastLine: r.timedOut
          ? `линт не уложился в ${ctx.timeoutMs} мс — идиоматичность НЕ проверялась`
          : `${mod.dir}: ${r.lastLine}`,
      };
    }

    const spec = eco?.lint?.(inModule);
    if (spec === undefined) {
      return {
        status: '⏭' as const,
        command: null,
        exitCode: null,
        lastLine: `для ${mod.dir} линтера нет — идиоматичность НЕ проверялась`,
      };
    }

    const r = await runSyntaxCheck(spec.cmd, spec.args, {
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      // Каталог модуля: пути линтеру даны относительно него, и стартовать он обязан там же.
      cwd,
      // Потолок этапа, а не десять секунд от `node --check`: линтер целого модуля
      // (`golangci-lint`, `cargo clippy`) в них не укладывается и краснел как «не успел».
      timeoutMs: ctx.timeoutMs,
    });
    const shown = `${spec.cmd} ${spec.args.join(' ')}`.trim();
    if (r.noTool) {
      return {
        status: '⏭' as const,
        command: shown,
        exitCode: null,
        lastLine: `линтер ${spec.cmd} не найден на машине — идиоматичность НЕ проверялась`,
      };
    }
    // Отмена и таймаут — отсутствие проверки, а не нарушение: красный по ним обвинял бы
    // код в том, чего никто не читал.
    if (r.aborted || r.timedOut) {
      return {
        status: '⏭' as const,
        command: shown,
        exitCode: null,
        lastLine: r.aborted
          ? `линт прерван отменой — идиоматичность НЕ проверялась`
          : `линт не уложился в ${ctx.timeoutMs} мс — идиоматичность НЕ проверялась`,
      };
    }
    const tail = r.output
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-3)
      .join(' ');
    return {
      status: r.code === 0 ? ('✅' as const) : ('❌' as const),
      command: shown,
      exitCode: r.code,
      lastLine:
        r.code === 0
          ? `нарушений нет${spec.scope === 'module' ? ' (проверен весь модуль, не только изменённое)' : ''}`
          : tail === ''
            ? 'линтер сообщил о нарушениях, вывод пуст'
            : tail,
    };
  });

  return aggregate(parts, {
    status: '⏭',
    command: null,
    exitCode: null,
    lastLine: 'линтовать нечего',
  });
};

/** Потолки гейта дублей: он эвристический, и минуты на критическом пути не стоит. */
const DUPLICATE_NAME_LIMIT = 30;
const DUPLICATE_SCAN_LIMIT = 2000;

/**
 * Список исходников проекта с потолком по числу файлов.
 *
 * Обход останавливается по достижении лимита и пропускает каталоги зависимостей и истории:
 * искать одноимённую функцию в `node_modules` бессмысленно, а времени это стоит больше,
 * чем весь остальной гейт.
 *
 * Асинхронный по той же причине, что и обход в `exec/tools/index.ts::grep`: `readdirSync`/
 * `statSync` сами по себе синхронны, но на большом дереве (до 2000 файлов) обход без единой
 * уступки циклу событий блокирует WebSocket-события и отмену прогона на всё время гейта.
 * Уступка на каждую запись каталога — тот же паттерн, что уже используется там.
 */
async function listSourceFiles(
  root: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.sdlc', 'venv', '__pycache__']);
  const out: string[] = [];
  let truncated = false;

  // Глубина обхода ограничена, а симлинки на каталоги не разворачиваются: `statSync` идёт
  // ПО ссылке, и каталожный цикл через симлинк уводил обход в бесконечную рекурсию —
  // потолок в 2000 его не останавливал, потому что считает только файлы.
  const MAX_DEPTH = 12;

  // Через функцию, а не полем: сигнал меняется ПО ХОДУ обхода, а сужение типа по первой
  // проверке заставляло компилятор считать вторую невозможной.
  const cancelled = (): boolean => signal !== undefined && signal.aborted;

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > MAX_DEPTH) return;
    if (cancelled()) return;
    let entries: string[];
    try {
      entries = readdirSync(rel === '' ? root : join(root, rel));
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= limit) {
        truncated = true;
        return;
      }
      // Отдаём управление циклу событий на каждую запись каталога: без этой уступки
      // отмена прогона и ответы по сокету ждали бы конца всего обхода.
      await new Promise((r) => setImmediate(r));
      if (cancelled()) return;
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const child = rel === '' ? name : `${rel}/${name}`;
      let isDir = false;
      try {
        const st = statSync(join(root, child), { throwIfNoEntry: false });
        if (st === undefined) continue;
        // `lstat` отдельно: симлинк на каталог пропускаем целиком.
        if (st.isDirectory() && lstatSync(join(root, child)).isSymbolicLink()) continue;
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      if (isDir) await walk(child, depth + 1);
      else if (CODE_EXTENSIONS.has(child.slice(child.lastIndexOf('.')).toLowerCase())) {
        out.push(child);
      }
    }
  };

  await walk('', 0);
  return { files: out, truncated };
}

/**
 * Гейт дублей хелперов: «не написали ли мы то, что уже есть».
 *
 * В `MINIMUM` не входит: это эвристика, а не обязательная проверка. Исход `⏭` с вопросом
 * человеку — находка требует его суждения, а не автоматического отказа.
 *
 * Потолок на объём обязателен: поиск по чужому репозиторию — это I/O на критическом пути
 * этапа, а гейт, добавляющий минуты, выключат первым.
 */
const duplicatesGate: BuiltinGate = async (ctx) => {
  // Без git diff получить нечем, и «пустой diff» тут означает «мы ничего не смотрели», а
  // не «дублей нет». Пока проверки не было, гейт печатал зелёное «дублировать нечего» и
  // вне репозитория, и на уже отменённом прогоне — отчитывался о проверке, которой не было.
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — дубли хелперов НЕ проверялись`,
    };
  }
  if (ctx.signal?.aborted === true) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: 'прогон отменён — дубли хелперов НЕ проверялись',
    };
  }

  const added = addedFunctionNames(diffLines(await cachedWorkingDiff(ctx)));
  if (added.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: null,
      lastLine: 'новых функций в diff нет — дублировать нечего',
    };
  }

  const { files, truncated } = await listSourceFiles(ctx.projectRoot, DUPLICATE_SCAN_LIMIT, ctx.signal);
  const checkedNames = Math.min(added.length, DUPLICATE_NAME_LIMIT);
  const found = findDuplicates(added.slice(0, DUPLICATE_NAME_LIMIT), files, (f) =>
    readIfExists(join(ctx.projectRoot, f)),
  );

  if (found.length === 0) {
    // Обрезанный обход и обрезанный список имён называются вслух: «не найдено» после
    // осмотра половины дерева — не то же самое, что «не найдено».
    const caveats = [
      truncated ? `осмотрены не все файлы (потолок ${DUPLICATE_SCAN_LIMIT})` : null,
      added.length > DUPLICATE_NAME_LIMIT
        ? `проверены не все имена: ${checkedNames} из ${added.length}`
        : null,
    ].filter((c): c is string => c !== null);
    return {
      status: '✅',
      command: null,
      exitCode: null,
      lastLine:
        `одноимённых объявлений не найдено (проверено имён: ${checkedNames})` +
        (caveats.length === 0 ? '' : ` — ${caveats.join('; ')}`),
    };
  }

  return {
    status: '⏭',
    command: null,
    exitCode: null,
    lastLine: [
      'похоже на переписанный хелпер — нужен ответ человека, а не правка кода:',
      ...found.slice(0, 5).map(
        (f) => `  «${f.name}» добавлена в ${f.addedIn}, одноимённое объявление уже есть в ${f.existsIn}`,
      ),
      'Если это разные вещи — подпишите строку неприменимости своим именем.',
    ].join('\n'),
  };
};

const untrackedGate: BuiltinGate = async (ctx) => {
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — нетракованные файлы НЕ проверялись`,
    };
  }

  // `-- .` ограничивает вывод текущим каталогом и печатает пути относительно него: в
  // монорепо, где projectRoot — подкаталог, без этого в отчёт приезжали бы чужие файлы.
  const res = await git(
    ['ls-files', '--others', '--exclude-standard', '--', '.'],
    ctx.projectRoot,
    ctx.signal,
  );

  if (res.code !== 0) {
    return {
      status: '⏭',
      command: 'git ls-files --others --exclude-standard',
      exitCode: res.code,
      lastLine: `git не смог перечислить нетракованные файлы: ${res.stderr.trim() || 'без вывода'}`,
      // Единственный случай среды в этом гейте: сам git не отработал. «Не репозиторий»
      // средой не является — это конфигурация проекта, чинится не другой машиной.
      envBlocked: true,
    };
  }

  // База chunk'а вычитается ровно по той же причине, что и в scope-гейте: файл, лежавший
  // в дереве ДО начала витка, — чужая незакоммиченная работа, а не выход исполнителя за
  // план. Без вычитания гейт краснел на каждой попытке от чужого лога, который исполнитель
  // не может ни завести в git, ни удалить: файл не его и вне `files_to_touch`.
  const before = ctx.baseline;
  const preexisting: string[] = [];

  const untracked = res.stdout
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l !== '')
    .filter((l) => !l.startsWith('.sdlc/'))
    .filter((l) => {
      if (before === null || !before.has(l)) return true;
      preexisting.push(l);
      return false;
    });

  /** Названная вслух чужая грязь: молча выкинутый файл читается как «его не было». */
  const baselineNote =
    preexisting.length === 0
      ? ''
      : `\nиз базы chunk'а (не работа этапа), не считается: ${preexisting.slice(0, 5).join(', ')}` +
        `${preexisting.length > 5 ? ` и ещё ${preexisting.length - 5}` : ''}`;

  if (untracked.length === 0) {
    return {
      status: '✅',
      command: 'git ls-files --others --exclude-standard',
      exitCode: 0,
      lastLine: `нетракованных файлов вне .sdlc/ нет${baselineNote}`,
    };
  }

  return {
    status: '❌',
    command: 'git ls-files --others --exclude-standard',
    exitCode: 1,
    // Перечень, а не число: «3 файла» оператор проверить не может, а имена — может.
    lastLine:
      `нетракованных файлов вне .sdlc/: ${untracked.length}\n` +
      untracked.map((p) => `  ${p}`).join('\n') +
      '\nкаждый обязан быть либо заведён в git, либо назван в .gitignore' +
      baselineNote,
  };
};

/**
 * «Scope: пути плана без правок» — сверка в обратную сторону.
 *
 * Основной scope-гейт ловит файл в diff'е, которого нет в плане. Этот — путь в плане,
 * которого нет в diff'е. Разница не косметическая: непокрытый путь означает либо
 * «передумали и не сказали», либо «забыли», и оба случая методология требует объяснить
 * в отчёте строкой «не потребовалось, потому что X» или «не сделано».
 *
 * Отсюда статус: непокрытый путь — не нарушение и не успех, а требование объяснения.
 * Автоматически отличить «не потребовалось» от «забыли» рантайм не может и не делает вид:
 * он называет пути, а судит по объяснению рецензент. Формально это `❌` — вердикт
 * не должен зеленеть, пока строки в отчёте нет; там же лежит и путь снять её подписанной
 * неприменимостью.
 */
/**
 * «Scope: нетракованные файлы» — то, что этап 5 создал, но в git не завёл.
 *
 * Проекты закрывали эту строку набора командой `git status --porcelain`: она печатает
 * список, но возвращает 0 при любом его содержимом. Гейт зеленел всегда — ложный зелёный
 * по построению, ровно на той поверхности, которая от ложных зелёных и сторожит.
 *
 * Что считается нарушением: файл вне `.sdlc/`, не завёденный в индекс. Игнорируемые git'ом
 * не считаются — их исключает сам `--exclude-standard`, а не наш список расширений: правило
 * игнорирования принадлежит проекту, и дублировать его здесь значило бы разойтись с ним
 * молча. Артефакты витка исключены по той же причине, что и в соседних scope-гейтах: они
 * сопровождение работы, а не её предмет.
 */
const planCoverageGate: BuiltinGate = async (ctx) => {
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — покрытие плана НЕ проверялось`,
    };
  }

  if (ctx.planFiles.length === 0) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: 'в плане нет files_to_touch — сверять нечего',
    };
  }

  const changed = (await changedPaths(ctx.projectRoot, ctx.signal)).map((f) =>
    normalizePlanPath(ctx.projectRoot, f),
  );
  const touched = new Set(changed);

  const uncovered = ctx.planFiles
    .map((p) => normalizePlanPath(ctx.projectRoot, p))
    .filter((p) => !touched.has(p));

  if (uncovered.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: `все ${ctx.planFiles.length} путей плана тронуты`,
    };
  }

  return {
    status: '❌',
    command: null,
    exitCode: 1,
    lastLine:
      `путей плана без правок: ${uncovered.length} из ${ctx.planFiles.length}\n` +
      uncovered.map((p) => `  ${p}`).join('\n') +
      '\nкаждый обязан получить в отчёте «не потребовалось, потому что X» либо «не сделано»',
  };
};

const scopeGate: BuiltinGate = async (ctx) => {
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — файлы вне плана НЕ проверялись`,
    };
  }

  let changed = await changedPaths(ctx.projectRoot, ctx.signal);

  // Файлы, изменённые ДО начала chunk'а и с тех пор не тронутые: чужая незакоммиченная
  // работа в дереве, а не выход исполнителя за план. Методология требует не просто их
  // исключить, но и НАЗВАТЬ отдельной строкой — молча выкинутый файл выглядит как «его не
  // было», и оператор не узнает, что база вообще понадобилась.
  const fromBaseline: string[] = [];

  if (ctx.baseline !== null) {
    const before = ctx.baseline;
    changed = changed.filter((f) => {
      const key = f.split('\\').join('/');
      const was = before.get(key);
      if (was === undefined) return true;
      if (hashOf(join(ctx.projectRoot, f)) === was) {
        fromBaseline.push(key);
        return false;
      }
      return true;
    });
  }

  /** Приписка про чужую грязь: не `✅` и не `❌`, а названный факт рядом с исходом. */
  const baselineNote =
    fromBaseline.length === 0
      ? ''
      : `\nвне плана, из базы chunk'а (не работа этапа): ${fromBaseline.slice(0, 5).join(', ')}` +
        `${fromBaseline.length > 5 ? ` и ещё ${fromBaseline.length - 5}` : ''}`;

  // Этап 5 обязан менять файлы. Нулевой diff после chunk'а — это не «чисто», это
  // «правки ушли мимо репозитория либо гейт смотрит не в тот каталог».
  const outsideSdlc = changed.filter((f) => !f.replace(/\\/g, '/').startsWith('.sdlc/'));
  if (outsideSdlc.length === 0) {
    return {
      status: '❌',
      command: null,
      exitCode: 1,
      lastLine:
        'git не видит ни одного изменения после этапа 5 вне .sdlc/ — либо правки ушли мимо ' +
        `репозитория, либо проверяется не тот каталог: ${ctx.projectRoot}`,
    };
  }

  const violations = scopeViolations(changed, ctx.planFiles, ctx.projectRoot);
  if (violations.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine:
        `все изменения в пределах files_to_touch (файлов: ${outsideSdlc.length})${baselineNote}`,
    };
  }
  const detail = violations
    .map((v) =>
      v.sameName
        ? `  ${v.path}   (same-name: в плане файл с этим именем в ДРУГОМ каталоге — вероятно промах модулем)`
        : `  ${v.path}`,
    )
    .join('\n');
  return {
    status: '❌',
    command: null,
    exitCode: 1,
    lastLine: `файлы вне files_to_touch:\n${detail}`,
  };
};

// ---------------------------------------------------------------------------
// Анти-обход тест-гейта
// ---------------------------------------------------------------------------

/**
 * Разбор diff'а на один прогон гейтов.
 *
 * «Анти-обход тест-гейта» и «Секреты в diff» — две строки набора, включаемые независимо,
 * но смотрят они в один и тот же diff. Пока каждая тянула его сама, при обоих включённых
 * гейтах было десять вызовов git вместо пяти и два полных прохода регулярок — при том
 * что комментарий рядом обещал «один разбор».
 *
 * Ключ кэша — САМ контекст прогона, а не корень проекта. Ключ по корню жил дольше прогона:
 * `runGates` создаёт контекст заново на каждую попытку, а запись в модульной карте
 * оставалась от предыдущей — вторая попытка chunk'а получала находки первой, и исполнитель,
 * который включил обратно отключённый тест, всё равно видел `❌`, а внесённый заново секрет
 * не видел никто. `WeakMap` по контексту истекает вместе с прогоном: сбрасывать нечего и
 * забыть сброс невозможно.
 */
const diffCache = new WeakMap<GateContext, Promise<InvariantViolation[]>>();

/**
 * Сам текст diff'а (не разбор) — тем же ключом-контекстом, что `diffCache`.
 *
 * «Дубли хелперов» тоже нуждается в diff'е (искать новые функции), но не в
 * `InvariantViolation[]` — общий разбор ему не подходит по форме. Без этого кэша при
 * «Анти-обход»/«Секреты» и «Дубли хелперов», включённых одновременно, `workingDiff` уходил
 * в git дважды на один и тот же прогон — тот же класс лишнего I/O, ради которого заведён
 * `diffCache` выше, только с другой формой результата.
 */
const rawDiffCache = new WeakMap<GateContext, Promise<string>>();

function cachedWorkingDiff(ctx: GateContext): Promise<string> {
  return memoByCtxAsync(rawDiffCache, ctx, () => workingDiff(ctx.projectRoot, [], ctx.signal));
}

function diffViolations(ctx: GateContext): Promise<InvariantViolation[]> {
  return memoByCtxAsync(diffCache, ctx, async () => {
    const diff = await cachedWorkingDiff(ctx);
    const deleted = await deletedPaths(ctx.projectRoot, ctx.signal);
    return invariantViolations(diff, deleted);
  });
}

/**
 * Гейт фильтрует находки по своим видам, иначе включённый «Секреты в diff» краснел бы от
 * отключённого теста, и по статусу нельзя было бы понять, что именно сломано.
 */
function makeDiffGate(kinds: ReadonlySet<string>, what: string): BuiltinGate {
  return async (ctx) => {
    if (!(await isRepo(ctx.projectRoot))) {
      return {
        status: '⏭',
        command: null,
        exitCode: null,
        lastLine: `${ctx.projectRoot} не git-репозиторий — ${what} по diff НЕ проверялся`,
      };
    }
    const violations = (await diffViolations(ctx)).filter((v) => kinds.has(v.kind));
    if (violations.length === 0) {
      return { status: '✅', command: null, exitCode: 0, lastLine: `${what} — чисто` };
    }
    return {
      status: '❌',
      command: null,
      exitCode: 1,
      lastLine: violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n'),
    };
  };
}

const antiBypassGate = makeDiffGate(
  new Set(['test-disabled', 'test-file-deleted', 'tests-removed']),
  'анти-обход тест-гейта',
);

const secretsGate = makeDiffGate(new Set(['secret-in-diff']), 'секреты в diff');

// ---------------------------------------------------------------------------
// Ответы человека в коде
// ---------------------------------------------------------------------------

/**
 * Гейт «Ответы человека в коде»: литералы из ответов человека (clarification-report.md)
 * ищутся в добавленных строках diff.
 *
 * Порог, который он сторожит, замерен (`docs/model-runs.md`, серии r7–r8): слабая модель
 * пишет корректный код, но теряет факт из диалога — «ставка 90%» из ответа не доезжает до
 * кода, и это видно только на этапе 6 по существу. Гейт превращает потерю в названный
 * красный ДО рецензента.
 *
 * Проверяются только механические литералы (числа, цитаты) — см. `humanFacts.ts`. Ответ
 * без литералов («на общих основаниях») машиной не сверяется, и гейт не изображает
 * обратного. Литерал, осевший не в коде, а в комментарии или тесте, гейт тоже засчитает —
 * это осознанная цена: строже значило бы парсить языки, а лгать «не найдено» на найденное
 * нельзя. Ложный красный снимается строкой неприменимости, подписанной именем.
 */
const humanAnswersGate: BuiltinGate = async (ctx) => {
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — ответы человека в diff НЕ проверялись`,
    };
  }

  const report = ctx.clarificationPath === undefined ? null : readIfExists(ctx.clarificationPath);
  if (report === null) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: 'clarification-report.md в витке нет — ответов человека не было, сверять нечего',
    };
  }

  const checkable = extractHumanFacts(report).filter((f) => f.literals.length > 0);
  if (checkable.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: 'в ответах человека нет проверяемых литералов (чисел, цитат) — сверять нечего',
    };
  }

  // Только добавленные строки — и БЕЗ артефактов витка: `workingDiff` включает
  // нетракованные файлы, то есть сам clarification-report.md, и гейт зеленел бы от
  // литералов вопроса, процитированных в отчёте, а не от кода (пойман тестом).
  // Регистр не гасится: правило «без регистра — только Windows-пути» держит pathsEqual,
  // и заводить здесь третью идиому сравнения нельзя.
  const clarRel = toPosix(relative(ctx.projectRoot, ctx.clarificationPath ?? ''));
  const added = diffLines(await cachedWorkingDiff(ctx))
    .filter((l) => l.added)
    .filter((l) => {
      const file = toPosix(l.file);
      return !file.startsWith('.sdlc/') && file !== clarRel;
    })
    .map((l) => l.text)
    .join('\n');

  const lost: string[] = [];
  for (const fact of checkable) {
    // КАЖДЫЙ литерал факта, а не любой: карточка в промпте обещает «каждое число и
    // каждая цитата обязаны быть отражены», и гейт обязан проверять то же самое —
    // «порог 300, ставка 1.5» с перенесённым порогом и потерянной ставкой не зелёный.
    // Число ищется как отдельный токен той же регуляркой, что задаёт границы экстрактор
    // (`literalPattern`): «90» не зеленеет ни от «190», ни от «base64»-подобных имён.
    const missing = fact.literals.filter(
      (lit) =>
        !lit.accepted.some((form) =>
          /^\d/.test(form) ? literalPattern(form).test(added) : added.includes(form),
        ),
    );
    if (missing.length > 0) {
      const lits = missing.map((l) => l.shown).join(', ');
      lost.push(`  «${fact.question}» → «${fact.answer}»: литералы (${lits}) в добавленных строках не найдены`);
    }
  }

  if (lost.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: `все ${checkable.length} ответов человека с литералами отражены в diff`,
    };
  }
  return {
    status: '❌',
    command: null,
    exitCode: 1,
    lastLine: `потерянные ответы человека: ${lost.length} из ${checkable.length}\n${lost.join('\n')}`,
  };
};

// ---------------------------------------------------------------------------
// Предусловия публикации (этап 7)
// ---------------------------------------------------------------------------

const publishGate: BuiltinGate = async (ctx) => {
  if (!(await isRepo(ctx.projectRoot))) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${ctx.projectRoot} не git-репозиторий — предусловия публикации НЕ проверялись`,
    };
  }
  const branch = await currentBranch(ctx.projectRoot);

  let commitsAhead: number | null = null;
  for (const base of ['origin/main', 'origin/master']) {
    const exists = await git(['rev-parse', '--verify', '--quiet', base], ctx.projectRoot);
    if (exists.code !== 0) continue;
    const r = await git(['rev-list', '--count', `${base}..HEAD`], ctx.projectRoot);
    commitsAhead = Number.parseInt(r.stdout.trim(), 10);
    if (Number.isNaN(commitsAhead)) commitsAhead = null;
    break;
  }

  const committed = (await hasCommits(ctx.projectRoot))
    ? (await git(['show', '--pretty=format:', '--name-only', 'HEAD'], ctx.projectRoot)).stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')
    : [];

  const problems = publishProblems({ branch, commitsAhead, committedFiles: committed });
  return problems.length === 0
    ? {
        status: '✅',
        command: null,
        exitCode: 0,
        lastLine: `ветка «${branch}», коммит чистый, есть что публиковать`,
      }
    : {
        status: '❌',
        command: null,
        exitCode: 1,
        lastLine: `публикация заблокирована:\n${problems.join('\n')}`,
      };
};

/**
 * Соответствие имён набора встроенным реализациям.
 *
 * «Ревью независимым агентом» здесь нет намеренно: его исполняет субагент этапа 6, а не
 * скрипт, и статус приходит из прогона, а не отсюда.
 */
export const BUILTIN: ReadonlyMap<string, BuiltinGate> = new Map<string, BuiltinGate>([
  ['сборка', buildGate],
  ['тесты', testGate],
  ['scope: файлы вне плана', scopeGate],
  ['scope: пути плана без правок', planCoverageGate],
  ['scope: нетракованные файлы', untrackedGate],
  ['анти-обход тест-гейта', antiBypassGate],
  ['секреты в diff', secretsGate],
  ['линт экосистемы', lintGate],
  ['ответы человека в коде', humanAnswersGate],
  ['дубли хелперов', duplicatesGate],
  ['проверка предусловий публикации', publishGate],
]);

export function builtinFor(gateName: string): BuiltinGate | null {
  return BUILTIN.get(gateKey(gateName)) ?? null;
}

/** Снимок грязного дерева перед этапом 5. */
export async function snapshotBaseline(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await changedPaths(projectRoot, signal)) {
    const h = hashOf(join(projectRoot, f));
    if (h !== null) out[f.replace(/\\/g, '/')] = h;
  }
  return out;
}
