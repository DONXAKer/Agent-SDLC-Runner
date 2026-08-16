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
import { dirname, join, relative } from 'node:path';

import type { NormalizedCall } from '@sdlc-runner/shared';

import { resolveUserPath, toPosix } from '../../policy/paths.ts';
import { runShell } from '../../gates/shell.ts';

export interface ToolContext {
  projectRoot: string;
  /** Потолок на результат одного вызова. Дальше — обрезка с честной пометкой. */
  maxResultBytes: number;
  /** Выше этого размера `Read` требует диапазон строк. */
  readRangeRequiredAboveBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
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

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Обрезаем с конца: начало вывода почти всегда информативнее хвоста.
  return `${text.slice(0, limit)}\n…[рантайм обрезал: показано ${limit} из ${text.length} символов]`;
}

function rel(root: string, abs: string): string {
  return toPosix(relative(root, abs)) || toPosix(abs);
}

function readTool(call: NormalizedCall & { kind: 'read' }, ctx: ToolContext): ToolOutcome {
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  if (!existsSync(abs)) return { ok: false, text: `файла нет: ${call.path}` };

  const size = statSync(abs).size;
  if (call.range === null && size > ctx.readRangeRequiredAboveBytes) {
    return {
      ok: false,
      text:
        `файл большой (${size} байт) — читай диапазоном строк (offset/limit). ` +
        `Целиком он вытеснит из контекста входные артефакты этапа.`,
    };
  }

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const from = call.range === null ? 1 : Math.max(1, call.range.from);
  const to = call.range === null ? lines.length : Math.min(lines.length, call.range.to);
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
  return {
    ok: true,
    text: `${existed ? 'перезаписан' : 'создан'} ${rel(ctx.projectRoot, abs)} (${lines} строк)`,
  };
}

function editTool(call: NormalizedCall & { kind: 'edit' }, ctx: ToolContext): ToolOutcome {
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  if (!existsSync(abs)) return { ok: false, text: `файла нет: ${call.path}` };

  let text = readFileSync(abs, 'utf8');
  const applied: string[] = [];

  for (const [i, e] of call.edits.entries()) {
    const count = text.split(e.oldStr).length - 1;
    if (count === 0) {
      return {
        ok: false,
        text: `правка ${i + 1}: фрагмент не найден. Ни одна правка не применена — прочитай файл заново.`,
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
    text = e.replaceAll ? text.split(e.oldStr).join(e.newStr) : text.replace(e.oldStr, e.newStr);
    applied.push(`${i + 1}: ${count} вхожд.`);
  }

  writeFileSync(abs, text, 'utf8');
  return { ok: true, text: `${rel(ctx.projectRoot, abs)} — правок применено: ${applied.join(', ')}` };
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

  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= MAX_HITS || ctx.signal.aborted) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_HITS) return;
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
      content.split(/\r?\n/).forEach((line, i) => {
        if (hits.length >= MAX_HITS || !re.test(line)) return;
        hits.push(`${rel(ctx.projectRoot, abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
  };

  try {
    if (statSync(base).isFile()) {
      const content = readFileSync(base, 'utf8');
      content.split(/\r?\n/).forEach((line, i) => {
        if (hits.length < MAX_HITS && re.test(line)) {
          hits.push(`${rel(ctx.projectRoot, base)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    } else {
      await walk(base);
    }
  } catch (e) {
    return { ok: false, text: `поиск не отработал: ${(e as Error).message}` };
  }

  if (hits.length === 0) return { ok: true, text: 'совпадений нет' };
  const note = hits.length >= MAX_HITS ? `\n…[показаны первые ${MAX_HITS} совпадений]` : '';
  return { ok: true, text: cap(hits.join('\n') + note, ctx.maxResultBytes) };
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
      return readTool(call, ctx);
    case 'write':
      return writeTool(call, ctx);
    case 'edit':
      return editTool(call, ctx);
    case 'glob':
      return globTool(call, ctx);
    case 'grep':
      return grepTool(call, ctx);
    case 'bash':
      return bashTool(call, ctx);
    default:
      return { ok: false, text: `инструмент «${call.kind}» этот цикл не исполняет` };
  }
}
