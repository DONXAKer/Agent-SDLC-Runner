/**
 * Инструменты флоу `loop`.
 *
 * Флоу `sdk` пользуется встроенными инструментами Claude Code — здесь их аналоги для
 * своего цикла. Ключевое: **политики тут нет**. Каждый вызов уже прошёл `onToolRequest`
 * до попадания сюда, и повторная проверка создала бы второе место с решением о доступе —
 * то самое, где два флоу и расходятся.
 *
 * Что инструмент обязан делать сам — не выдавать результат больше, чем модель способна
 * прочитать: локальный контур живёт на 16K контекста, и один `Grep` по монорепо съедает
 * его целиком.
 */

import type { Dirent } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';

import type { ArtifactKey, NormalizedCall } from '@sdlc-runner/shared';

import { applyFill } from '../../artifacts/applyFill.ts';
import { resolveUserPath, toPosix } from '../../policy/paths.ts';
import { runShell } from '../../gates/shell.ts';
import { templateNameFor } from '../../run/seed.ts';

export interface ToolContext {
  projectRoot: string;
  /** Потолок на результат одного вызова. Дальше — обрезка с честной пометкой. */
  maxResultBytes: number;
  /** Выше этого размера `Read` требует диапазон строк. */
  readRangeRequiredAboveBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Ключ артефакта → путь, для `FillField`. Тот же список, что решал доступ политикой
   * (`PolicyContext.stageArtifacts`) — второй карты здесь нет, только выборка нужных
   * инструментов из общей. Не задан — `FillField` этого исполнителя не достигает вовсе
   * (право не выдано без него), но функция остаётся честной и на пустом списке.
   */
  artifacts?: readonly { key: ArtifactKey; path: string }[];
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
]);

/**
 * Обрезка результата по БАЙТАМ, а не по символам.
 *
 * Лимит называется `maxToolResultBytes` и меряет место в контексте модели. Пока резали
 * по `length` (единицы UTF-16), 60 000 «символов» кириллицы означали ~120 000 байт —
 * вдвое больше объявленного потолка, то есть ровно тот случай, ради предотвращения
 * которого лимит и заведён.
 */
// Экспортируется ради результатов MCP-вызовов: у них тот же лимит и та же цена ошибки,
// а вторая копия этой функции разошлась бы с первой ровно на кириллице, как уже было.
export function cap(text: string, limitBytes: number): string {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= limitBytes) return text;

  // Режем по границе символа: половина суррогатной пары в выводе — мусор.
  const head = Buffer.from(text, 'utf8').subarray(0, limitBytes).toString('utf8');
  const clean = head.endsWith('�') ? head.slice(0, -1) : head;
  return `${clean}\n…[рантайм обрезал: показано ${limitBytes} из ${size} байт]`;
}

function rel(root: string, abs: string): string {
  return toPosix(relative(root, abs)) || toPosix(abs);
}

/** Тот же формат, что у `Read`: без номеров строк модель не с чем сверить старый `old_string`. */
function numberedLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l, i) => `${i + 1}\t${l}`)
    .join('\n');
}

/**
 * Именованные экспорты файла — грубым разбором текста, не компилятором.
 *
 * Ловит `export const/function/class/interface/type/enum X` и `export { X, Y as Z }`.
 * Не ловит `export default`, реэкспорты через `export * from`, и любой синтаксис, до
 * которого эти два выражения не дотягиваются — то есть недобор возможен, перебора нет.
 * Пустой результат (регексп ничего не понял в файле) — сигнал НЕ доверять этому файлу для
 * сверки: `verifyTsImports` из-за этого молчит, если множество пусто, а не считает файл
 * без единого экспорта.
 */
function namedExportsOf(source: string): Set<string> {
  const names = new Set<string>();
  const DECL_RE = /\bexport\s+(?:declare\s+)?(?:const|function|class|interface|type|enum|abstract\s+class)\s+(\w+)/g;
  for (const m of source.matchAll(DECL_RE)) names.add(m[1]!);
  const LIST_RE = /\bexport\s*\{([^}]+)\}/g;
  for (const m of source.matchAll(LIST_RE)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * Резолвит спецификатор относительного импорта в абсолютный путь на диске.
 *
 * Соглашение проекта — относительные импорты пишутся с расширением `.ts` явно (см.
 * CLAUDE.md), поэтому прямое совпадение пробуется первым; `.ts`/`index.ts` — на случай
 * файла из другого проекта, где соглашение не соблюдено. `null` — не относительный путь
 * (пакет, алиас) или файла нет ни в одном варианте: не наш случай, молчим.
 */
function resolveRelativeImport(fromFileAbs: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolvePath(dirname(fromFileAbs), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Найден живым прогоном (`docs/model-runs.md`, серия r33, `qwen3:30b-a3b` с продлённым
 * `--stage-timeout`): модель написала `import { Add, Subtract } from './money.ts'` — с
 * заглавной буквы, которых там нет (реальные имена — `add`/`subtract`), тесты прогнала
 * один раз задолго до этой правки и не заметила, что импорт с тех пор сломался. Не
 * подменяет typecheck — это точечная проверка ровно того класса ошибки, что уже пойман, и
 * работает без запуска компилятора на КАЖДУЮ правку (дорого на большом проекте).
 *
 * `null` — нареканий нет либо проверить нечем (файл не найден, регексп не понял его
 * структуру). Строка — готовый к показу модели список расхождений.
 */
function verifyTsImports(content: string, fileAbs: string, projectRoot: string): string | null {
  const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  const problems: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const names = m[1]!
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .map((n) => n.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim());
    const targetAbs = resolveRelativeImport(fileAbs, m[2]!);
    if (targetAbs === null) continue;
    let targetSrc: string;
    try {
      targetSrc = readFileSync(targetAbs, 'utf8');
    } catch {
      continue;
    }
    const exported = namedExportsOf(targetSrc);
    if (exported.size === 0) continue;
    for (const name of names) {
      if (!exported.has(name)) {
        problems.push(
          `«${name}» не экспортируется из ${rel(projectRoot, targetAbs)} ` +
            `(там есть: ${[...exported].slice(0, 12).join(', ')})`,
        );
      }
    }
  }
  return problems.length === 0 ? null : problems.join('; ');
}

/** Замена первого вхождения ровно тем текстом, что передан: без раскрытия `$`-групп. */
function replaceFirstLiteral(text: string, from: string, to: string): string {
  const i = text.indexOf(from);
  return i < 0 ? text : text.slice(0, i) + to + text.slice(i + from.length);
}

/**
 * Ошибка файловой системы — это результат инструмента, а не крах этапа.
 *
 * `Read` каталога (`EISDIR`), запись под существующим файлом (`ENOTDIR`), отказ прав
 * (`EACCES`) — обычные ошибки 4B-модели. Пока они летели наружу, этап падал целиком:
 * терялись и финальный текст, и вся история сообщений, хотя модели достаточно было
 * сказать «так нельзя».
 */
async function guard(action: () => ToolOutcome | Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await action();
  } catch (e) {
    return { ok: false, text: `операция не удалась: ${(e as Error).message}` };
  }
}

function readTool(call: NormalizedCall & { kind: 'read' }, ctx: ToolContext): ToolOutcome {
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  if (!existsSync(abs)) return { ok: false, text: `файла нет: ${call.path}` };

  const size = statSync(abs).size;
  // «С начала и без конца» — это чтение целиком, как бы оно ни было записано. Пока
  // предохранитель смотрел только на `range === null`, модель обходила его одним
  // `offset: 1` без `limit` — и выгребала в контекст весь файл, ради чего проверка и стоит.
  const wholeFile = call.range === null || (call.range.from <= 1 && call.range.to === null);
  if (wholeFile && size > ctx.readRangeRequiredAboveBytes) {
    return {
      ok: false,
      text:
        `файл большой (${size} байт) — читай диапазоном строк (offset/limit). ` +
        `Целиком он вытеснит из контекста входные артефакты этапа.`,
    };
  }

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const from = call.range === null ? 1 : Math.max(1, call.range.from);
  const to =
    call.range === null || call.range.to === null
      ? lines.length
      : Math.min(lines.length, call.range.to);
  // Нумерация строк обязательна: без неё Edit по «строке 42» не с чем сверить, а модель
  // всё равно её выдумает.
  const body = lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}\t${l}`)
    .join('\n');
  return { ok: true, text: cap(body, ctx.maxResultBytes) };
}

function writeTool(call: NormalizedCall & { kind: 'write' }, ctx: ToolContext): ToolOutcome {
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  mkdirSync(dirname(abs), { recursive: true });
  const existed = existsSync(abs);
  writeFileSync(abs, call.content, 'utf8');
  const lines = call.content.split('\n').length;
  const base = `${existed ? 'перезаписан' : 'создан'} ${rel(ctx.projectRoot, abs)} (${lines} строк)`;

  if (/\.tsx?$/.test(abs)) {
    const problem = verifyTsImports(call.content, abs, ctx.projectRoot);
    if (problem !== null) {
      return {
        ok: false,
        text: `${base}\nимпорт не сходится с целевым файлом: ${problem}. Файл уже записан на диск — поправь импорт следующей правкой.`,
      };
    }
  }
  return { ok: true, text: base };
}

/**
 * Заполняет одно поле артефакта. Путь берётся из `ctx.artifacts` по ключу — политика уже
 * проверила, что этап производит этот артефакт (`policy/index.ts: evaluateFillField`), а
 * второй раз резолвить ключ здесь означало бы второе место, где ключ→путь может разойтись.
 * Разбор значения и рендер markdown — `applyFill`, здесь только диск.
 */
function fillFieldTool(call: NormalizedCall & { kind: 'fill_field' }, ctx: ToolContext): ToolOutcome {
  const entry = (ctx.artifacts ?? []).find((a) => a.key === call.artifact);
  if (entry === undefined) return { ok: false, text: `артефакт «${call.artifact}» не найден на этом этапе` };
  if (!existsSync(entry.path)) {
    return { ok: false, text: `бланк ${call.artifact} ещё не разложен на диске — заполнять нечего` };
  }
  const current = readFileSync(entry.path, 'utf8');
  const applied = applyFill(current, call.field, call.value, call.op, templateNameFor(entry.path));
  if (!applied.ok) return { ok: false, text: applied.problem };
  writeFileSync(entry.path, applied.text, 'utf8');
  return { ok: true, text: `${rel(ctx.projectRoot, entry.path)}.${call.field} — записано: ${applied.rendered}` };
}

function editTool(call: NormalizedCall & { kind: 'edit' }, ctx: ToolContext): ToolOutcome {
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  if (!existsSync(abs)) return { ok: false, text: `файла нет: ${call.path}` };

  let text = readFileSync(abs, 'utf8');
  const applied: string[] = [];

  for (const [i, e] of call.edits.entries()) {
    const count = text.split(e.oldStr).length - 1;
    if (count === 0) {
      // Текущее содержимое — прямо в ответе, а не отсылкой «прочитай заново»: живые прогоны
      // (`docs/model-runs.md`, серия r33) показали серии из 4–26 подряд промахов той же
      // модели по тому же файлу — она не звала повторный Read и гадала по памяти. Здесь
      // `text` уже учитывает правки ЭТОГО ЖЕ вызова, применённые раньше в цикле.
      return {
        ok: false,
        text:
          `правка ${i + 1}: фрагмент не найден. Ни одна правка не применена.\n` +
          `Текущее содержимое ${rel(ctx.projectRoot, abs)} (для сверки, отдельный Read не нужен):\n` +
          cap(numberedLines(text), ctx.maxResultBytes),
      };
    }
    // Единственность обязательна, иначе правка попадёт не туда, где её ждали, и это
    // всплывёт только на ревью. Массовая замена — отдельное явное решение.
    if (count > 1 && !e.replaceAll) {
      return {
        ok: false,
        text:
          `правка ${i + 1}: фрагмент встречается ${count} раз. Возьми больше контекста ` +
          `или укажи replace_all. Ни одна правка не применена.`,
      };
    }
    // split/join, а не String.replace: у `replace` текст замены — не литерал, в нём
    // `$&`, `$1`, `` $` `` раскрываются как подстановки. Правка new_string="'$1.99'"
    // клала на диск "'.99'", отчитываясь при этом «применено». Один и тот же old/new
    // давал разный результат в зависимости от replace_all — здесь ветки уравнены.
    text = e.replaceAll
      ? text.split(e.oldStr).join(e.newStr)
      : replaceFirstLiteral(text, e.oldStr, e.newStr);
    applied.push(`${i + 1}: ${count} вхожд.`);
  }

  writeFileSync(abs, text, 'utf8');
  const base = `${rel(ctx.projectRoot, abs)} — правок применено: ${applied.join(', ')}`;

  if (/\.tsx?$/.test(abs)) {
    const problem = verifyTsImports(text, abs, ctx.projectRoot);
    if (problem !== null) {
      return {
        ok: false,
        text: `${base}\nимпорт не сходится с целевым файлом: ${problem}. Правка уже применена — поправь импорт следующей правкой.`,
      };
    }
  }
  return { ok: true, text: base };
}

async function globTool(
  call: NormalizedCall & { kind: 'glob' },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const base = call.path === null ? ctx.projectRoot : resolveUserPath(ctx.projectRoot, call.path);
  const found: string[] = [];
  try {
    for await (const entry of glob(call.pattern, { cwd: base })) {
      const path = toPosix(String(entry));
      if (path.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
      found.push(path);
      if (found.length >= 300) break;
    }
  } catch (e) {
    return { ok: false, text: `шаблон не отработал: ${(e as Error).message}` };
  }
  if (found.length === 0) return { ok: true, text: 'совпадений нет' };
  return { ok: true, text: cap(found.sort().join('\n'), ctx.maxResultBytes) };
}

/**
 * Потолок времени на поиск.
 *
 * Выражение приходит от модели, а движок регулярных выражений в JS не прерывается: на
 * вложенном повторении вроде `(a+)+$` он уходит в экспоненциальный бэктрекинг и держит
 * весь процесс — вместе с HTTP-ручкой отмены и WebSocket-потоком всех остальных витков.
 * Прервать это можно только снаружи, поэтому обход сверяется с часами и с сигналом на
 * каждом файле, а не «когда-нибудь».
 */
const GREP_BUDGET_MS = 20_000;

/**
 * Отказ по вложенному повторению (`(a+)+`) живёт в `policy/denyList.ts`, а не здесь:
 * решения «можно/нельзя» принимают общие для обоих флоу чистые функции, и правило,
 * спрятанное в реализации инструмента, второй флоу не защищает. Сюда вызов доходит уже
 * пропущенным политикой — остаётся бюджет времени на честно дорогой, но законный поиск.
 */
async function grepTool(
  call: NormalizedCall & { kind: 'grep' },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  let re: RegExp;
  try {
    re = new RegExp(call.pattern, 'i');
  } catch (e) {
    return { ok: false, text: `выражение не разобралось: ${(e as Error).message}` };
  }

  const base = call.path === null ? ctx.projectRoot : resolveUserPath(ctx.projectRoot, call.path);
  const hits: string[] = [];
  const MAX_HITS = 200;
  const deadline = Date.now() + GREP_BUDGET_MS;
  let stopped: string | null = null;

  const scan = (abs: string, content: string): void => {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= MAX_HITS) return;
      if ((i & 0xff) === 0 && Date.now() > deadline) {
        stopped = 'выражение оказалось слишком дорогим';
        return;
      }
      if (re.test(lines[i]!)) {
        hits.push(`${rel(ctx.projectRoot, abs)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      }
    }
  };

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= MAX_HITS || stopped !== null) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || stopped !== null) return;
      // Отдаём управление циклу событий: обход синхронный, и без этой уступки отмена
      // прогона и ответы по сокету ждали бы конца обхода.
      await new Promise((r) => setImmediate(r));
      if (ctx.signal.aborted) {
        stopped = 'поиск прерван отменой прогона';
        return;
      }
      if (Date.now() > deadline) {
        stopped = 'поиск не уложился в отведённое время';
        return;
      }

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = join(dir, entry.name);
      let content: string;
      try {
        // Бинарные и огромные файлы пропускаем: искать в них нечего, а память они съедят.
        if (statSync(abs).size > 2_000_000) continue;
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      // Нулевой байт — признак бинарного файла: искать в нём регулярным выражением нечего.
      if (content.includes(String.fromCharCode(0))) continue;
      scan(abs, content);
    }
  };

  try {
    if (statSync(base).isFile()) {
      scan(base, readFileSync(base, 'utf8'));
    } else {
      await walk(base);
    }
  } catch (e) {
    return { ok: false, text: `поиск не отработал: ${(e as Error).message}` };
  }

  if (stopped !== null && hits.length === 0) {
    return {
      ok: false,
      text: `${stopped}. Сузь шаблон или задай path — вложенные повторения вида «(a+)+» дороги.`,
    };
  }

  // Обрыв обхода называется ВСЕГДА, а не только когда не нашлось ничего. Пока он молчал
  // при непустом результате, «поиск не уложился в отведённое время» выглядел для модели
  // как исчерпывающий ответ, и она делала вывод «больше вхождений нет» по недосмотренному
  // дереву — на этом держится половина ложных «расхождений не найдено».
  const cut = stopped === null ? '' : `\n…[${stopped}: дерево просмотрено НЕ полностью]`;

  if (hits.length === 0) {
    return { ok: true, text: stopped === null ? 'совпадений нет' : `совпадений нет.${cut}` };
  }
  const note = hits.length >= MAX_HITS ? `\n…[показаны первые ${MAX_HITS} совпадений]` : '';
  // Пометка идёт ПЕРЕД совпадениями: `cap` режет хвост, и предупреждение о неполноте
  // исчезало бы ровно на длинном результате, где оно нужнее всего.
  const body = cut === '' ? '' : `${cut.trim()}\n`;
  return { ok: true, text: cap(body + hits.join('\n') + note, ctx.maxResultBytes) };
}

async function bashTool(
  call: NormalizedCall & { kind: 'bash' },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const r = await runShell(call.command, {
    cwd: ctx.projectRoot,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  if (r.denied !== null) return { ok: false, text: r.lastLine };

  const body = [r.stdout, r.stderr].filter((s) => s.trim() !== '').join('\n--- stderr ---\n');
  const head = r.timedOut
    ? `команда не уложилась в ${ctx.timeoutMs} мс`
    : `код возврата ${r.exitCode ?? '—'}`;
  return { ok: r.exitCode === 0 && !r.timedOut, text: cap(`${head}\n${body}`, ctx.maxResultBytes) };
}

/**
 * Исполняет вызов, УЖЕ прошедший гейт одобрений.
 *
 * `ask_human`, `finalize_artifact` и `subagent` сюда не попадают: их обрабатывает цикл,
 * потому что им нужен не диск, а человек, состояние этапа и вложенный прогон.
 */
export async function executeTool(call: NormalizedCall, ctx: ToolContext): Promise<ToolOutcome> {
  switch (call.kind) {
    case 'read':
      return guard(() => readTool(call, ctx));
    case 'write':
      return guard(() => writeTool(call, ctx));
    case 'edit':
      return guard(() => editTool(call, ctx));
    // Под `guard` ВСЕ, включая асинхронные: `Glob`, `Grep` и `Bash` ходят на диск ровно
    // так же, и `EACCES` на подкаталоге или снятый носитель ронял этап целиком — вместе с
    // финальным текстом и всей историей сообщений, — хотя модели достаточно было сказать
    // «так нельзя». Раньше их обходило то, что `guard` был синхронным.
    case 'glob':
      return guard(() => globTool(call, ctx));
    case 'grep':
      return guard(() => grepTool(call, ctx));
    case 'bash':
      return guard(() => bashTool(call, ctx));
    case 'fill_field':
      return guard(() => fillFieldTool(call, ctx));
    default:
      return { ok: false, text: `инструмент «${call.kind}» этот цикл не исполняет` };
  }
}
