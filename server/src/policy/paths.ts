/**
 * Лексическая работа с путями — без обращений к файловой системе.
 *
 * Политика доступа обязана быть чистой: её гоняет conformance-тест на обоих флоу, и она
 * должна давать один и тот же ответ, не завися ни от состояния диска, ни от платформы.
 * Проверка symlink-побегов требует I/O и живёт не здесь, а в реализации инструментов.
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

/** Абсолютный нормализованный корень без хвостового слэша. */
export function normalizeRoot(root: string): string {
  const n = lexicalNormalize(root);
  return n.endsWith('/') && n.length > 3 ? n.slice(0, -1) : n;
}

/** Путь пользователя, разрешённый относительно корня проекта. */
export function resolveUserPath(root: string, userPath: string): string {
  return isAbsolute(userPath)
    ? lexicalNormalize(userPath)
    : lexicalNormalize(`${normalizeRoot(root)}/${userPath}`);
}

/**
 * Windows-пути сравниваем без учёта регистра: конфиг и ввод модели регулярно расходятся
 * в написании (`D:/Проекты` против `d:/проекты`), а файл при этом один и тот же.
 */
function windowsStyle(root: string): boolean {
  return /^[A-Za-z]:\//.test(toPosix(root));
}

function eq(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Путь относительно корня в форме, пригодной для сравнения: прямые слэши, без `./`.
 * `null` — цель лежит вне корня.
 */
export function relativizeWithin(root: string, absolute: string): string | null {
  const r = normalizeRoot(root);
  const a = lexicalNormalize(absolute);
  const ci = windowsStyle(r);

  if (eq(a, r, ci)) return '';
  const withSlash = `${r}/`;
  if (eq(a.slice(0, withSlash.length), withSlash, ci)) return a.slice(withSlash.length);
  return null;
}

/**
 * Планы приходят с путями в той форме, в какой их выдала модель: абсолютные, относительные,
 * с префиксом `./`, или с хвостовым комментарием «: что тут делаем». Всё это означает один
 * и тот же файл, поэтому перед сравнением сводится к одной форме.
 */
export function normalizePlanPath(root: string, raw: string): string {
  let p = toPosix(raw.trim());

  // Отрезаем хвостовую заметку, но не трогаем букву диска ("C:/...").
  const colon = p.indexOf(':');
  if (colon > 1) p = p.slice(0, colon).trim();

  const r = normalizeRoot(root);
  const ci = windowsStyle(r);
  const withSlash = `${r}/`;
  if (eq(p.slice(0, withSlash.length), withSlash, ci)) p = p.slice(withSlash.length);
  if (p.startsWith('./')) p = p.slice(2);

  return lexicalNormalize(p);
}
