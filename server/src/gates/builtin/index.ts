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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { GateStatus } from '@sdlc-runner/shared';

import { changedPaths, currentBranch, deletedPaths, git, hasCommits, isRepo, workingDiff } from '../git.ts';
import { gateKey } from '../gatesFile.ts';
import { runShell } from '../shell.ts';
import type { InvariantViolation } from './logic.ts';
import {
  detectBuildSystem,
  invariantViolations,
  moduleDirFromPlan,
  publishProblems,
  scopeViolations,
} from './logic.ts';

export interface GateContext {
  projectRoot: string;
  /** `files_to_touch` одобренного плана — вход scope-гейта и детекта модуля. */
  planFiles: readonly string[];
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

function resolveModule(ctx: GateContext): { dir: string; files: Set<string> } | null {
  const dir = moduleDirFromPlan(ctx.planFiles, (d) => {
    const files = dirEntries(ctx.projectRoot, d);
    return detectBuildSystem(files, readIfExists(join(ctx.projectRoot, d, 'package.json'))) !== null;
  });
  if (dir === null) return null;
  return { dir, files: dirEntries(ctx.projectRoot, dir) };
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
function nodeCheck(
  path: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', path], {
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const err: string[] = [];
    let settled = false;
    const done = (r: { code: number | null; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Без своего потолка гейт «Сборка» висел бы до таймаута всего этапа: у `node --check`
    // собственного лимита нет, а процесс, севший на блокировке файла (антивирус, сетевой
    // диск), не закроется сам.
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stderr: `node --check не уложился в ${NODE_CHECK_TIMEOUT_MS} мс` });
    }, NODE_CHECK_TIMEOUT_MS);
    timer.unref?.();

    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    child.on('error', (e) => done({ code: null, stderr: e.message }));
    child.on('close', (code) => done({ code, stderr: err.join('') }));
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
  const changed = (await changedPaths(ctx.projectRoot, ctx.signal)).filter((f) => JS_FILE.test(f));
  if (changed.length === 0) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine: `${why} — КОМПИЛЯЦИЯ НЕ ПРОВЕРЯЛАСЬ, проверять синтаксисом тоже нечего`,
    };
  }

  // Проверки независимы, поэтому идут пачками: последовательный запуск поднимал процесс
  // node на каждый файл (≈96 мс на файл, ~4 с на сорок) прямо на критическом пути
  // оператора, а разом — рождал по процессу на каждый изменённый файл, и на витке,
  // затронувшем сотню, машина уходила в своп. Путь передаётся аргументом, а не
  // вклеивается в строку команды.
  const outcomes = await inBatches(
    changed.filter((f) => existsSync(join(ctx.projectRoot, f))),
    NODE_CHECK_PARALLEL,
    async (f) => ({ f, r: await nodeCheck(join(ctx.projectRoot, f), ctx.signal) }),
  );

  const bad: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const { f, r } of outcomes) {
    if (r.code === 0) {
      checked++;
      continue;
    }
    if (
      /Cannot use import statement outside a module|Unexpected token '(export|<)'|Unexpected token </.test(
        r.stderr,
      )
    ) {
      skipped++;
      continue;
    }
    checked++;
    bad.push(`  ${f}: ${r.stderr.split(/\r?\n/).slice(0, 3).join(' ')}`);
  }

  if (bad.length > 0) {
    return {
      status: '❌',
      command: 'node --check',
      exitCode: 1,
      lastLine: `синтаксическая ошибка — файл не загрузится:\n${bad.join('\n')}`,
    };
  }
  if (checked > 0) {
    // `⏭`, а не `✅`. Разбор нескольких `.js` парсером — это не сборка: правка со
    // сломанным импортом или падающим require проходит `node --check` и получала зелёный
    // обязательный гейт «Сборка». Гейт, который врёт, приучает игнорировать себя, поэтому
    // здесь честный пропуск: он роняет вердикт, пока человек не подпишет неприменимость.
    return {
      status: '⏭',
      command: 'node --check',
      exitCode: 0,
      lastLine:
        `СБОРКА НЕ ЗАПУСКАЛАСЬ (${why}). Проверен только синтаксис: файлов ${checked} ` +
        `(пропущено ESM/JSX: ${skipped}). Ошибки связывания, типов и импортов не проверены.`,
    };
  }
  return {
    status: '⏭',
    command: null,
    exitCode: null,
    lastLine:
      `${why}; из ${changed.length} изменённых .js не проверен ни один ` +
      `(пропущено ESM/JSX: ${skipped}). СИНТАКСИС НЕ ПРОВЕРЕН.`,
  };
}

const buildGate: BuiltinGate = async (ctx) => {
  const mod = resolveModule(ctx);
  if (mod === null) {
    return syntaxOnly(ctx, 'build-система не обнаружена');
  }
  const system = detectBuildSystem(
    mod.files,
    readIfExists(join(ctx.projectRoot, mod.dir, 'package.json')),
  );
  if (system === null) return syntaxOnly(ctx, 'build-система не обнаружена');

  // Без node_modules npm-скрипт падает на отсутствующем vite/esbuild, и возврат на
  // доработку отправил бы исполнителя чинить несуществующую поломку кода, спалив
  // попытки. «Нечем собирать» — это не «код не собирается».
  if (system.needsNodeModules && !existsSync(join(ctx.projectRoot, mod.dir, 'node_modules'))) {
    return syntaxOnly(ctx, `в ${mod.dir} нет node_modules`);
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
};

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

const testGate: BuiltinGate = async (ctx) => {
  const mod = resolveModule(ctx);
  const system =
    mod === null
      ? null
      : detectBuildSystem(mod.files, readIfExists(join(ctx.projectRoot, mod.dir, 'package.json')));

  // «Раннера нет» и «тесты упали» — разные вещи, и различать их обязательно: первое
  // оставляет пункты приёмки, держащиеся на тесте, НЕПОДТВЕРЖДЁННЫМИ, второе означает
  // сломанный код.
  if (mod === null || system === null || system.test === null) {
    return {
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine:
        'тест-раннер не обнаружен — ТЕСТЫ НЕ ЗАПУСКАЛИСЬ. Пункты приёмки, проверяемые ' +
        'только тестом, остаются неподтверждёнными.',
    };
  }
  if (system.needsNodeModules && !existsSync(join(ctx.projectRoot, mod.dir, 'node_modules'))) {
    return {
      status: '⏭',
      command: system.test,
      exitCode: null,
      lastLine: `в ${mod.dir} нет node_modules — ТЕСТЫ НЕ ЗАПУСКАЛИСЬ (зависимости не установлены)`,
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
  };
};

// ---------------------------------------------------------------------------
// Scope: файлы вне плана
// ---------------------------------------------------------------------------

function hashOf(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return createHash('md5').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

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

  if (ctx.baseline !== null) {
    const before = ctx.baseline;
    changed = changed.filter((f) => {
      const was = before.get(f.replace(/\\/g, '/'));
      if (was === undefined) return true;
      return hashOf(join(ctx.projectRoot, f)) !== was;
    });
  }

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
      lastLine: `все изменения в пределах files_to_touch (файлов: ${outsideSdlc.length})`,
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
const diffCache = new WeakMap<GateContext, InvariantViolation[]>();

async function diffViolations(ctx: GateContext): Promise<InvariantViolation[]> {
  const cached = diffCache.get(ctx);
  if (cached !== undefined) return cached;

  const diff = await workingDiff(ctx.projectRoot, [], ctx.signal);
  const deleted = await deletedPaths(ctx.projectRoot, ctx.signal);
  const violations = invariantViolations(diff, deleted);
  diffCache.set(ctx, violations);
  return violations;
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
  ['анти-обход тест-гейта', antiBypassGate],
  ['секреты в diff', secretsGate],
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
