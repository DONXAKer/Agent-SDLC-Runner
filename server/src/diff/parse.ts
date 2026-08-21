/**
 * Разбор unified diff — один на всю кодовую базу.
 *
 * До него разборов было четыре: анти-обходной гейт, метрика близости патчей, размер патча
 * в журнале итераций и ручка сводного просмотра. Каждый отличал заголовок файла от строки
 * тела по префиксу `+++`/`---`, и каждый на этом ломался: строка КОДА, начинающаяся с
 * `++` или `--` (`++i` в C, разделитель в Markdown, diff внутри diff), выглядела как
 * заголовок. Проверено прогоном: патч одного файла со строкой `+++ добавленная строка`
 * давал «Файлов: 2», а `diffCloseness` возвращала 1.0 для двух заведомо разных патчей.
 *
 * Здесь граница тела считается так, как её определяет сам формат: по счётчикам из
 * `@@ -a,b +c,d @@`. Пока счётчики не исчерпаны, строка принадлежит телу, чем бы она ни
 * начиналась. Это не эвристика, а разбор.
 */

export interface DiffHunk {
  /** Файл новой стороны. Для удаления — файл старой стороны. */
  file: string;
  /** Строки тела как есть, вместе с ведущим ' ', '+' или '-'. */
  lines: string[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** Файлы в порядке первого появления — включая удалённые. */
  files: string[];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

export function parseDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  const files: string[] = [];
  const seen = new Set<string>();

  let file = '';
  let current: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const noteFile = (name: string): void => {
    file = name.trim();
    if (file !== '' && file !== '/dev/null' && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  };

  for (const raw of patch.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');

    // `@@` и `diff --git` обрывают тело безусловно: в корректном unified diff строка тела
    // всегда начинается с ' ', '+', '-' или '\', поэтому голый заголовок в начале строки
    // телом быть не может. Нужно потому, что счётчики в заголовке не всегда верны —
    // сокращённый или собранный руками патч (в том числе в тестовых фикстурах) объявляет
    // больше строк, чем содержит, и без этих терминаторов hunk'и склеивались бы.
    // На `+++`/`---` это НЕ распространяется: они совпадают с настоящим содержимым строки
    // кода, и различить их можно только по счётчикам.
    const structural = current !== null && /^(@@ |diff --git )/.test(line);

    // Пока тело hunk'а не исчерпано, строка принадлежит телу — что бы ни стояло в начале.
    if (current !== null && !structural && (oldLeft > 0 || newLeft > 0)) {
      const head = line[0] ?? ' ';
      if (head === '+') newLeft--;
      else if (head === '-') oldLeft--;
      else if (head === '\\') {
        // «\ No newline at end of file» ни к одной стороне не относится.
      } else {
        oldLeft--;
        newLeft--;
      }
      current.lines.push(line);
      continue;
    }
    current = null;

    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      // Счётчик по умолчанию — 1: `@@ -3 +3 @@` без запятой означает одну строку.
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current = { file, lines: [] };
      hunks.push(current);
      continue;
    }

    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus !== null) {
      noteFile(plus[1] ?? '');
      continue;
    }
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader !== null) {
      noteFile(gitHeader[2] ?? '');
      continue;
    }
    // `--- a/path` при удалении файла: новая сторона `/dev/null`, и без старой стороны
    // удалённый файл не попал бы в список вовсе.
    const minus = /^--- (?:a\/)?(.+)$/.exec(line);
    if (minus !== null) {
      const name = (minus[1] ?? '').trim();
      if (name !== '/dev/null' && file === '') noteFile(name);
      continue;
    }
  }

  return { hunks: hunks.filter((h) => h.lines.length > 0), files };
}

/** Размер патча: сколько файлов тронуто и сколько строк изменено. */
export function patchSize(patch: string): { files: number; lines: number } {
  const { hunks, files } = parseDiff(patch);
  let lines = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      const head = l[0] ?? ' ';
      if (head === '+' || head === '-') lines++;
    }
  }
  return { files: files.length, lines };
}

/**
 * Добавленные/удалённые строки на файл — тем же разбором, что и всё остальное здесь.
 *
 * Существует для сводного просмотра патча: до неё клиент считал +/− своей копией по
 * префиксу `+++`/`---`, ровно тем эвристическим способом, который эта функция и заменяет.
 */
export function fileStats(patch: string): { path: string; adds: number; dels: number }[] {
  const { hunks, files } = parseDiff(patch);
  const counts = new Map<string, { adds: number; dels: number }>();
  for (const f of files) counts.set(f, { adds: 0, dels: 0 });
  for (const h of hunks) {
    const c = counts.get(h.file);
    if (c === undefined) continue;
    for (const l of h.lines) {
      const head = l[0] ?? ' ';
      if (head === '+') c.adds++;
      else if (head === '-') c.dels++;
    }
  }
  return files.map((path) => ({ path, ...(counts.get(path) ?? { adds: 0, dels: 0 }) }));
}
