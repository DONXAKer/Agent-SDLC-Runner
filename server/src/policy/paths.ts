/**
 * Лексическая работа с путями — без обращений к файловой системе.
 *
 * Политика доступа обязана быть чистой: её гоняет conformance-тест, и она должна давать
 * один и тот же ответ, не завися ни от состояния диска, ни от платформы. Проверка
 * symlink-побегов требует I/O и живёт не здесь, а в гейте одобрений.
 */

import { matchesGlob } from 'node:path';

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Приводит путь к канонической форме, схлопывая `.` и `..`, без чтения диска. */
export function lexicalNormalize(p: string): string {
  const posix = toPosix(p.trim());

  let prefix = '';
  let rest = posix;

  const drive = /^([A-Za-z]):\/?/.exec(posix);
  if (drive !== null) {
    prefix = `${drive[1]!.toUpperCase()}:/`;
    rest = posix.slice(drive[0].length);
  } else if (posix.startsWith('/')) {
    prefix = '/';
    rest = posix.slice(1);
  }

  const parts: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = parts[parts.length - 1];
      if (parts.length > 0 && last !== '..') parts.pop();
      // Для абсолютного пути `..` выше корня схлопывается, как и в ОС.
      else if (prefix === '') parts.push('..');
      continue;
    }
    parts.push(seg);
  }

  return prefix + parts.join('/');
}

export function isAbsolute(p: string): boolean {
  const posix = toPosix(p);
  return posix.startsWith('/') || /^[A-Za-z]:\//.test(posix);
}

/** Абсолютный нормализованный корень без хвостового слэша (кроме самого корня диска). */
export function normalizeRoot(root: string): string {
  return lexicalNormalize(root);
}

/** Корень с гарантированным одним хвостовым слэшем — для сравнения префиксов. */
function rootWithSlash(root: string): string {
  const r = normalizeRoot(root);
  return r.endsWith('/') ? r : `${r}/`;
}

/**
 * Windows-пути сравниваем без учёта регистра: конфиг и ввод модели регулярно расходятся
 * в написании (`D:/Проекты` против `d:/проекты`), а файл при этом один и тот же.
 */
export function isWindowsStyle(root: string): boolean {
  return /^[A-Za-z]:\//.test(toPosix(root));
}

export function pathsEqual(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Гашение регистра пути по фактической платформе ПРОЦЕССА — второе, отдельное правило
 * рядом с `isWindowsStyle` (то — про СТИЛЬ записи пути, для сравнения двух написаний из
 * конфига/ввода). Это — про то, различает ли регистр сама ФС под ногами: Windows и
 * штатная macOS/APFS — нет, Linux — да. Одно место на весь рантайм: третья рукописная
 * идиома сравнения регистра в гейте уже расходилась с первыми двумя (ревью-3).
 * Ограничение названо честно: case-sensitive том на macOS этим правилом не различим.
 */
export function foldPathCase(p: string): string {
  return process.platform === 'linux' ? p : p.toLowerCase();
}

/**
 * Чинит две формы, которые модели выдают регулярно и которые иначе валят весь блок плана
 * (порт `PathScope.normalizeUserPath` из Java): повторённый корень внутри относительного
 * пути (`Проекты/App/src/x.ts` при корне `D:/Проекты/App`).
 *
 * Требуется совпадение минимум двух сегментов корня: при одном сегменте `src/x.ts` в
 * проекте с корнем `.../src` был бы неотличим от настоящего вложенного `src/src/x.ts`,
 * и «починка» ломала бы верный путь.
 */
function repairRepeatedRoot(root: string, rel: string): string {
  const ci = isWindowsStyle(root);
  const rootSegs = normalizeRoot(root)
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^\//, '')
    .split('/')
    .filter((s) => s !== '');

  for (let k = rootSegs.length; k >= 2; k--) {
    const prefix = `${rootSegs.slice(-k).join('/')}/`;
    if (pathsEqual(rel.slice(0, prefix.length), prefix, ci)) return rel.slice(prefix.length);
  }
  return rel;
}

/** Путь пользователя, разрешённый относительно корня проекта. */
export function resolveUserPath(root: string, userPath: string): string {
  if (isAbsolute(userPath)) return lexicalNormalize(userPath);
  const repaired = repairRepeatedRoot(root, toPosix(userPath.trim()));
  return lexicalNormalize(`${rootWithSlash(root)}${repaired}`);
}

/**
 * Путь относительно корня в форме, пригодной для сравнения: прямые слэши, без `./`.
 * `null` — цель лежит вне корня.
 */
export function relativizeWithin(root: string, absolute: string): string | null {
  const r = normalizeRoot(root);
  const a = lexicalNormalize(absolute);
  const ci = isWindowsStyle(r);

  if (pathsEqual(a, r, ci)) return '';
  const withSlash = rootWithSlash(root);
  if (pathsEqual(a.slice(0, withSlash.length), withSlash, ci)) return a.slice(withSlash.length);
  return null;
}

/** Лежит ли путь внутри одного из перечисленных корней (для каталогов только на чтение). */
export function isWithinAny(roots: readonly string[], absolute: string): boolean {
  return roots.some((r) => relativizeWithin(r, absolute) !== null);
}

/**
 * Планы приходят с путями в той форме, в какой их выдала модель: абсолютные, относительные,
 * с префиксом `./`, или с хвостовым комментарием «: что тут делаем». Всё это означает один
 * и тот же файл, поэтому перед сравнением сводится к одной форме.
 */
export function normalizePlanPath(root: string, raw: string): string {
  let p = toPosix(raw.trim());

  // Отрезаем хвостовую заметку. Двоеточие ищем ПОСЛЕ префикса диска: иначе у
  // `D:/proj/src/a.ts: правим тут` срабатывало двоеточие диска на индексе 1, условие
  // «colon > 1» не выполнялось, и заметка оставалась частью пути — такой пункт плана
  // не совпадал ни с одной записью, и агент ретраил до конца бюджета.
  const driveEnd = /^[A-Za-z]:\//.test(p) ? 2 : 0;
  const colon = p.indexOf(':', driveEnd);
  if (colon >= 0) p = p.slice(0, colon).trim();

  const ci = isWindowsStyle(root);
  const withSlash = rootWithSlash(root);
  if (pathsEqual(p.slice(0, withSlash.length), withSlash, ci)) p = p.slice(withSlash.length);
  if (p.startsWith('./')) p = p.slice(2);

  return lexicalNormalize(repairRepeatedRoot(root, p));
}

/**
 * Фильтр имён поиска, разобранный один раз, в семантике `rg --glob` — одна функция на
 * политику (`pathScope::deniedInScope`: задевает ли поиск закрытый файл) и на исполнение
 * `Grep` флоу `loop`: понимай они фильтр по-разному, политика разрешала бы то, что инструмент
 * потом читает (code-review-all 2026-09-23 — `!*.ts` читался политикой как «только .ts»).
 *
 * `grep`: один или несколько шаблонов через пробел или запятую ВНЕ фигурных скобок
 * (`*.ts,*.md` — два шаблона, `*.{ts,md}` — один). Шаблон с `!` исключает, прочие —
 * включают (любой из них); только исключающие — «всё, кроме». Без `/` шаблон сверяется с
 * именем файла на любой глубине, с `/` — с путём от каталога поиска. `glob`: шаблон один
 * (шаблон `Glob`), сверяется с путём от каталога поиска. Ведущее `./` снимается. Шаблон,
 * который `matchesGlob` не разобрал, решается в сторону «файл проходит»: не включает его
 * меньше и не исключает.
 *
 * `alt` — второй вид того же пути для ВКЛЮЧЕНИЯ (политика подаёт путь без ведущих точек:
 * `**` в `matchesGlob` не заходит в `.sdlc`, а исполнитель флоу `sdk` заходить может).
 * Исключение сверяется только с настоящим путём: `!.sdlc/**` исключает файл витка, и
 * поиск, сам исключивший каталог витка, не отклоняется.
 */
export function compileSearchFilter(
  filter: string,
  mode: 'grep' | 'glob',
  caseInsensitive = false,
): (name: string, fromBase: string, alt?: string) => boolean {
  const norm = (v: string): string => (caseInsensitive ? v.toLowerCase() : v);
  const parts = (mode === 'glob' ? [toPosix(filter).trim()] : splitGlobList(toPosix(filter)))
    .filter((p) => p !== '')
    .map((p) => ({ neg: p.startsWith('!'), glob: norm((p.startsWith('!') ? p.slice(1) : p).replace(/^\.\//, '')) }));
  const include = parts.filter((p) => !p.neg);
  const exclude = parts.filter((p) => p.neg);
  const hits = (glob: string, target: string, onError: boolean): boolean => {
    try {
      return matchesGlob(norm(target), glob);
    } catch {
      return onError;
    }
  };
  const targetOf = (glob: string, name: string, fromBase: string): string =>
    mode === 'glob' || glob.includes('/') ? fromBase : name;
  return (name, fromBase, alt) => {
    if (exclude.some((p) => hits(p.glob, targetOf(p.glob, name, fromBase), false))) return false;
    if (include.length === 0) return true;
    return include.some(
      (p) =>
        hits(p.glob, targetOf(p.glob, name, fromBase), true) ||
        (alt !== undefined && hits(p.glob, targetOf(p.glob, name, alt), true)),
    );
  };
}

/** Шаблоны через пробел или запятую — кроме запятых внутри `{…}`. */
function splitGlobList(filter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of filter) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if ((/\s/.test(ch) && depth === 0) || (ch === ',' && depth === 0)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
