/**
 * Лексическая работа с путями — без обращений к файловой системе.
 *
 * Политика доступа обязана быть чистой: её гоняет conformance-тест, и она должна давать
 * один и тот же ответ, не завися ни от состояния диска, ни от платформы. Проверка
 * symlink-побегов требует I/O и живёт не здесь, а в гейте одобрений.
 */

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
