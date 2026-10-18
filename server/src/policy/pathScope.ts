/**
 * Первый уровень confinement: «лежит ли путь внутри проекта».
 *
 * Порт `tools/PathScope.java`. Проверка лексическая и потому чистая; побеги через symlink
 * ловятся в гейте одобрений, где уже есть доступ к диску (`approval/symlink.ts`).
 *
 * Отдельная оговорка про чтение. Промпт этапа прямым текстом велит читать формы артефактов
 * из каталога методологии, а он лежит вне целевого проекта. Запрет на это ломал виток на
 * первом же шаге: модель сочиняла артефакт своими словами, а счётчик плейсхолдеров
 * показывал ноль, потому что `‹…›` бывают только у скопированного шаблона. Поэтому
 * каталоги форм и текстов этапов открыты — но **только на чтение**.
 */

import type { NormalizedCall, PolicyContext, PolicyVerdict } from '@sdlc-runner/shared';
import { POLICY_OK, policyDeny } from '@sdlc-runner/shared';

import { compileSearchFilter, isWindowsStyle, isWithinAny, pathsEqual, relativizeWithin, resolveUserPath } from './paths.ts';

export type Access = 'read' | 'write';

/**
 * Сохранённый харнессом вывод инструмента (флоу `sdk`): большой вывод `Bash` Claude Code
 * пишет в файл вне проекта и отдаёт модели путь. Пока чтение шло только через
 * `canUseTool`, до него доходило; с хуком `PreToolUse` на `Read` модель теряла вывод своих
 * же тестов (code-review-all 2026-09-23). Открыт только `tool-results/` ТЕКУЩЕЙ сессии:
 * сессии человека и прошлые прогоны verify того же проекта держат вывод, который
 * `readDenied` закрывает.
 */
function isHarnessToolResult(ctx: PolicyContext, abs: string): boolean {
  const root = ctx.harnessResultsRoot;
  if (root === undefined) return false;
  const rel = relativizeWithin(root, abs);
  return rel !== null && /^tool-results\/[^/]/.test(rel);
}

/** Путь относительно корня, либо verdict с отказом. */
export function within(ctx: PolicyContext, userPath: string, access: Access): string | PolicyVerdict {
  const abs = resolveUserPath(ctx.projectRoot, userPath);
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel !== null) return rel;

  if (access === 'read' && isWithinAny(ctx.readOnlyRoots, abs)) return abs;
  if (access === 'read' && isHarnessToolResult(ctx, abs)) return abs;

  const extra =
    access === 'read' && ctx.readOnlyRoots.length > 0
      ? ` На чтение дополнительно открыты: ${ctx.readOnlyRoots.join(', ')}.`
      : '';

  return policyDeny(
    'pathScope',
    `путь «${userPath}» ведёт за пределы проекта (${ctx.projectRoot}).${extra}`,
  );
}

/**
 * Путь, закрытый на чтение на этом этапе.
 *
 * Не «нижняя граница» и не границы проекта, а сужение чтения ради независимости
 * рецензента: файл лежит внутри проекта и доступен всем остальным этапам. Сравнение —
 * тем же `pathsEqual`, что и у защищённых от записи артефактов, чтобы «читать нельзя» и
 * «писать нельзя» не разошлись в понимании одного и того же пути.
 *
 * Отказ выносится под именем `readScope`, а не `pathScope`: стенд классифицирует отказы по
 * имени политики, и слепой Grep агента claims по корню проекта (устройство шага, не
 * посягательство) ставил прогону метку «опасна» как «путь вне проекта» (b6-1, 2026-09-24).
 */
function isReadDenied(ctx: PolicyContext, rel: string): boolean {
  const ci = isWindowsStyle(ctx.projectRoot);
  return (ctx.readDenied ?? []).some((p) => pathsEqual(p, rel, ci));
}

/**
 * Может ли поиск задеть закрытый на чтение отчёт: каталог поиска его накрывает, а фильтр
 * имён (`glob` у Grep, шаблон у Glob) его не исключает. Возвращает закрытый файл или `null`.
 *
 * Точный путь закрыт `isReadDenied`, но `Grep {path: ".sdlc/<slug>"}` печатал строки
 * прошлых отчётов, `Glob` по тому же каталогу — их имена, а Grep от корня проекта (`path`
 * не задан) — и то и другое (code-review-all 2026-09-23). Закрыть поиск от корня целиком
 * значило бы закрыть ревью, поэтому решает фильтр: `glob: "*.ts"` отчёта не заденет, поиск
 * без фильтра — заденет. Фильтр разбирает та же `compileSearchFilter`, которой его
 * применяет исполнитель флоу `loop`.
 */
function deniedInScope(
  ctx: PolicyContext,
  userPath: string | null,
  filter: string | null,
  kind: 'glob' | 'grep',
): string | null {
  const denied = ctx.readDenied ?? [];
  if (denied.length === 0) return null;
  let base = '';
  if (userPath !== null) {
    const r = within(ctx, userPath, 'read');
    if (typeof r !== 'string') return null; // вне проекта — отказ даст checkPath
    base = r.replace(/\/+$/, '');
  }
  const ci = isWindowsStyle(ctx.projectRoot);
  const dir = base === '' || base === '.' ? '' : `${base}/`;
  const passes = filter === null ? null : compileSearchFilter(filter, kind, ci);
  for (const p of denied) {
    if (dir !== '' && !pathsEqual(p.slice(0, dir.length), dir, ci)) continue;
    if (passes === null) return p;
    const fromBase = p.slice(dir.length);
    const name = p.slice(p.lastIndexOf('/') + 1);
    // `**` в `matchesGlob` не заходит в каталоги с точкой (`.sdlc`), а исполнитель флоу
    // `sdk` в них заходить может: для включения сверяется и путь без ведущих точек.
    const undotted = fromBase.split('/').map((seg) => seg.replace(/^\.+/, '')).join('/');
    if (passes(name, fromBase, undotted)) return p;
  }
  return null;
}

function checkPath(ctx: PolicyContext, userPath: string, access: Access): PolicyVerdict {
  const r = within(ctx, userPath, access);
  if (typeof r !== 'string') return r;
  if (access === 'read' && isReadDenied(ctx, r)) {
    return policyDeny(
      'readScope',
      `чтение «${r}» на этапе ${ctx.stage} закрыто этому вызывающему: отчёт другой попытки ` +
        `(независимость ревью) либо авторский лист задачи (слепой вывод claims). Связь между ` +
        `попытками несут retry_instruction и carry_forward, которые подаёт машина витка; ` +
        `второму агенту разведки задача приходит только выдержкой в его задании.`,
    );
  }
  return POLICY_OK;
}

/**
 * Шаблон поиска, уводящий за пределы проекта.
 *
 * Разрешить `..` внутри шаблона нельзя — путь в нём не резолвится лексически (звёздочки
 * могут раскрыться во что угодно), поэтому единственная надёжная проверка — запретить
 * абсолютные шаблоны и восхождение вверх. Формы методологии читаются через `Read`, где
 * `readOnlyRoots` работает штатно, так что легальных случаев эта строгость не задевает.
 */
function checkSearchPattern(ctx: PolicyContext, pattern: string): PolicyVerdict | null {
  const p = pattern.replace(/\\/g, '/');
  const absolute = /^([A-Za-z]:\/|\/|\\\\)/.test(p);
  const ascends = p.split('/').includes('..');
  if (!absolute && !ascends) return null;

  return policyDeny(
    'pathScope',
    `шаблон поиска «${pattern}» ведёт за пределы проекта (${ctx.projectRoot}). ` +
      `Ищи относительным шаблоном внутри проекта; формы методологии читай инструментом Read.`,
  );
}

function deniedSearch(ctx: PolicyContext, hit: string): PolicyVerdict {
  return policyDeny(
    'readScope',
    `поиск на этапе ${ctx.stage} задел бы «${hit}» — файл, закрытый этому вызывающему на ` +
      `чтение. Сузь поиск: каталог исходников в path или фильтр имён (Grep: glob, например ` +
      `"*.ts"; Glob: шаблон по коду). Артефакты витка (intent.md, plan.md) читай Read или ` +
      `Grep по самому файлу. Связь между попытками несут retry_instruction и carry_forward, ` +
      `которые подаёт машина витка.`,
  );
}

/** Перечисление каталога через Read сохраняет те же границы, что поиск имён через Glob. */
export function directoryReadScope(ctx: PolicyContext, path: string): PolicyVerdict {
  const hit = deniedInScope(ctx, path, null, 'glob');
  return hit === null ? POLICY_OK : deniedSearch(ctx, hit);
}

export function check(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
  switch (call.kind) {
    case 'read':
      return checkPath(ctx, call.path, 'read');
    case 'write':
    case 'edit':
      return checkPath(ctx, call.path, 'write');
    case 'glob': {
      // Шаблон — тоже путь. Пока проверялось только необязательное поле `path`,
      // `Glob {pattern: "C:/Users/user/.claude/*.json"}` уходил наружу проекта, и следа
      // не оставалось даже в очереди одобрений: поиск в неё не ставится по дешевизне.
      const patternProblem = checkSearchPattern(ctx, call.pattern);
      if (patternProblem !== null) return patternProblem;
      const hit = deniedInScope(ctx, call.path, call.pattern, 'glob');
      if (hit !== null) return deniedSearch(ctx, hit);
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path, 'read');
    }
    case 'grep':
      // У `Grep` шаблон — это регулярное выражение по СОДЕРЖИМОМУ, а не путь, и мерить его
      // тем же предикатом нельзя: `\d+`, `\bimport\b`, `C:\\Users` внутри разбираемой
      // строки после замены `\` на `/` выглядят как абсолютный путь или восхождение вверх,
      // и обычный поиск получал отказ политики, снять который оператор не может. Каталог
      // поиска ограничивает поле `path` — оно и проверяется.
      {
        // Поиск по самому закрытому файлу сюда не попадает (каталог поиска его не
        // накрывает) — его отклонит `checkPath` своим текстом.
        const hit = deniedInScope(ctx, call.path, call.glob ?? null, 'grep');
        if (hit !== null) return deniedSearch(ctx, hit);
      }
      return call.path === null ? POLICY_OK : checkPath(ctx, call.path, 'read');
    // Bash исполняется с cwd = корень проекта. Цели редиректов, уходящие наружу
    // (включая /dev/null и временные файлы), здесь намеренно не трогаем — модель
    // законно пишет во временные файлы, а отказ политики оператор снять не может.
    default:
      return POLICY_OK;
  }
}
