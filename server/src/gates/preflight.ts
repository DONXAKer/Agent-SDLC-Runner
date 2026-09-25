/**
 * Preflight набора гейтов: исполним ли он в этой среде — ДО того, как потрачена попытка.
 *
 * `SDLC.md` → этап 5: «Попытка не начинается, пока набор неисполним. Команды включённых
 * гейтов этапа 6 проверяются на исполнимость в среде до первой правки (первое слово команды
 * находится в PATH или как путь от корня проекта); неисполнимая — это `blocked_env` до
 * попытки, а не после полного круга реализации». Порт `gates-preflight.py` методологии.
 *
 * Что проверяется, ничего не запуская:
 *  - первое слово команды исполнимо: встроенная команда оболочки, путь от корня проекта
 *    (`./gradlew`, `make -C test`), либо PATH (с `PATHEXT` на Windows); в docker-песочнице
 *    проекта — `command -v` внутри контейнера, потому что инструменты живут там;
 *  - для интерпретаторов (`python`, `node`, `bash`, …) — что скрипт-аргумент существует;
 *  - команду не отклонит пол безопасности (`denyList`): отклонённая команда неисполнима
 *    по построению и при прогоне даст `⏭` — набор надо чинить до старта, не после этапа 6.
 * Строка без команды — `no-command`: её исполняет встроенная реализация либо она уже
 * блокер старта витка (`unimplementedGates`), preflight'у тут добавить нечего.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import { checkBash } from '../policy/denyList.ts';
import { findSandboxForCwd } from '../sandbox/registry.ts';
import type { GateRow, GatesFile } from './gatesFile.ts';
import { firstToken } from './missingTool.ts';

const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'bash', 'sh']);
const BUILTINS = new Set(['true', 'false', 'echo', 'cd', 'export', 'set', 'test']);

export interface PreflightRow {
  gate: string;
  command: string | null;
  token: string;
  status: 'ok' | 'missing' | 'denied' | 'no-command';
  detail: string;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p;
}

function pathExists(token: string, root: string): boolean {
  const norm = expandHome(token.replace(/\\/g, '/'));
  const p = isAbsolute(norm) ? norm : join(root, norm);
  return existsSync(p) || existsSync(`${p}.bat`) || existsSync(`${p}.cmd`) || existsSync(`${p}.exe`);
}

/** Есть ли исполняемый файл с таким именем в PATH (на Windows — с расширениями PATHEXT). */
export function inPath(token: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':').filter((d) => d !== '');
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, token + ext))) return true;
    }
  }
  return false;
}

function isPathLike(token: string): boolean {
  return /^(\.\/|\.\\|\/|~)/.test(token) || token.includes('/') || token.includes('\\');
}

function executableLocally(token: string, root: string): boolean {
  if (token === '') return false;
  if (BUILTINS.has(token)) return true;
  if (isPathLike(token)) return pathExists(token, root);
  return inPath(token);
}

/**
 * Для интерпретатора — путь скрипта: первый аргумент не с `-`, который ПОХОЖ на файл
 * (расширение или разделитель пути). `node --import tsx --test`, `python -X utf8 run.py`,
 * `bash -lc "npm test"` — аргументы опций файлами не являются, и требовать их существования
 * значило бы блокировать вход в этап по опечатке preflight'а (ревью). Иначе `null`.
 */
export function scriptOf(cmd: string, tok: string): string | null {
  const base = tok.replace(/\\/g, '/').split('/').pop()?.split('.')[0] ?? '';
  if (!INTERPRETERS.has(base)) return null;
  const parts = cmd.split(/\s+/).filter((p) => p !== '');
  const idx = parts.indexOf(tok);
  for (const p of parts.slice(idx < 0 ? 0 : idx + 1)) {
    if (p.startsWith('-')) {
      if (p === '-m' || p === '-c' || p === '-e') return null; // модуль/строка кода — файла нет
      continue;
    }
    return /[/\\]|\.[A-Za-z0-9]{1,5}$/.test(p) && !/^["']/.test(p) ? p : null;
  }
  return null;
}

/**
 * Исполнимость первого слова команды в среде проекта. В docker-песочнице спрашивается сам
 * контейнер (`command -v`): PATH хоста там ни о чём не говорит.
 */
async function executable(token: string, root: string): Promise<boolean> {
  const sandbox = findSandboxForCwd(root);
  if (sandbox !== null && sandbox.exec.kind === 'docker') {
    if (BUILTINS.has(token)) return true;
    const probe = isPathLike(token) ? `test -e ${shellQuote(token)}` : `command -v ${shellQuote(token)}`;
    try {
      const r = await sandbox.exec.exec(probe, { cwd: root, timeoutMs: 15_000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
  return executableLocally(token, root);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function preflightGates(
  gates: GatesFile,
  projectRoot: string,
  stage: GateRow['reportsAt'] = 'этап 6',
): Promise<PreflightRow[]> {
  const rows: PreflightRow[] = [];
  for (const row of gates.rows.filter((r) => r.enabled && r.reportsAt === stage)) {
    if (row.command === null) {
      rows.push({ gate: row.name, command: null, token: '', status: 'no-command', detail: 'команды в обратных кавычках нет' });
      continue;
    }
    const denied = checkBash(row.command, 'gate');
    if (!denied.ok) {
      rows.push({
        gate: row.name,
        command: row.command,
        token: firstToken(row.command),
        status: 'denied',
        detail: `команду отклонит пол безопасности: ${denied.reason} — при прогоне она даст ⏭ «исполнить нечем»`,
      });
      continue;
    }
    const tok = firstToken(row.command);
    let ok = await executable(tok, projectRoot);
    let detail = ok ? '' : `«${tok}» не найден: ни в PATH, ни как путь от корня проекта`;
    const script = ok ? scriptOf(row.command, tok) : null;
    if (script !== null && !pathExists(script, projectRoot)) {
      ok = false;
      detail = `скрипт «${script}» не найден: ни от корня проекта, ни по абсолютному пути, ни через ~`;
    }
    rows.push({ gate: row.name, command: row.command, token: tok, status: ok ? 'ok' : 'missing', detail });
  }
  return rows;
}

/**
 * Блокеры старта этапа по preflight'у: одна строка на неисполнимый гейт с готовой строкой
 * долга набора (`SDLC.md`: дефект окружения заводится один раз на проект). Пусто — набор
 * исполним или команд в нём нет.
 */
export async function preflightGateBlockers(gates: GatesFile, projectRoot: string): Promise<string[]> {
  const rows = await preflightGates(gates, projectRoot);
  return rows
    .filter((r) => r.status === 'missing' || r.status === 'denied')
    .map(
      (r) =>
        `гейт «${r.gate}» неисполним в этой среде (\`${r.command ?? ''}\`): ${r.detail}. ` +
        `Это blocked_env ДО попытки — попытка не тратится, среду или набор чинит человек. ` +
        (r.status === 'missing'
          ? `Строка долга набора (один раз на проект): | ${r.gate}: нет «${r.token}» в среде исполнения | этап 6 | ` +
            '‹кто и чем закрывает: ставит инструмент / собирает образ› | ‹дата› | ‹имя› |'
          : 'Замени команду строки набора на исполнимую.'),
    );
}
