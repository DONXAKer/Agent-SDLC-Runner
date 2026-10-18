/**
 * Счёт патча по файлам для свидетельства попытки — порт `sdlc_common.diffstat` методологии.
 *
 * Отдельно от `parse.ts`: там разбор тела hunk'ов по счётчикам для гейтов и метрик, здесь —
 * та же форма записи, что пишет `attempt-evidence.py`, чтобы `evidence.json` раннера и
 * терминальной сессии читались одним инструментом (`attempt-evidence.py verify`, гейт
 * «Перезапись файла»). Заголовки файла читаются только до первого `@@`, поэтому строки
 * `++…`/`--…` внутри hunk'ов заголовками не считаются; `--- /dev/null` — новый файл,
 * `+++ /dev/null` — удалённый целиком.
 */

export interface DiffstatFile {
  path: string;
  new: boolean;
  deleted: boolean;
  added: number;
  removed: number;
}

export interface Diffstat {
  files: number;
  added: number;
  deleted: number;
  paths: string[];
  /** Файлы, удалённые целиком, — отдельным списком: вход гейта «Перезапись файла». */
  deleted_paths: string[];
  per_file: Record<string, { added: number; deleted: number; new: boolean; deleted_entirely: boolean }>;
}

const DIFF_GIT = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/;
const OCT = /\\([0-7]{3})/g;

/** Путь в кавычках с октальными эскейпами (на случай `core.quotepath` у чужого git). */
export function unquoteGitPath(p: string): string {
  const s = p.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const bytes: number[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    OCT.lastIndex = 0;
    while ((m = OCT.exec(inner)) !== null) {
      for (const ch of Buffer.from(inner.slice(last, m.index), 'utf8')) bytes.push(ch);
      bytes.push(parseInt(m[1]!, 8));
      last = m.index + m[0].length;
    }
    for (const ch of Buffer.from(inner.slice(last), 'utf8')) bytes.push(ch);
    return Buffer.from(bytes).toString('utf8');
  }
  return s;
}

export function patchFiles(patch: string): DiffstatFile[] {
  const files: DiffstatFile[] = [];
  let cur: DiffstatFile | null = null;
  let inHeader = false;
  for (const ln of patch.split(/\r?\n/)) {
    const m = DIFF_GIT.exec(ln);
    if (m !== null) {
      const b = m[3] ?? m[4] ?? '';
      cur = { path: unquoteGitPath(b), new: false, deleted: false, added: 0, removed: 0 };
      files.push(cur);
      inHeader = true;
      continue;
    }
    if (cur === null) continue;
    if (inHeader) {
      if (ln.startsWith('@@')) {
        inHeader = false;
      } else if (ln.startsWith('--- ')) {
        if (ln.slice(4).trim() === '/dev/null') cur.new = true;
      } else if (ln.startsWith('+++ ')) {
        const tgt = ln.slice(4).trim();
        if (tgt === '/dev/null') cur.deleted = true;
        else if (tgt.startsWith('b/') || tgt.startsWith('"b/')) cur.path = unquoteGitPath(tgt).slice(2);
      }
      continue;
    }
    if (ln.startsWith('@@')) continue;
    if (ln.startsWith('+')) cur.added++;
    else if (ln.startsWith('-')) cur.removed++;
  }
  return files;
}

export interface HunkLine {
  path: string;
  /** Номер строки: в новой версии для `+`, в старой — для `-`. */
  line: number;
  sign: '+' | '-';
  text: string;
}

/** Добавленные и удалённые строки всех hunk'ов с номерами — порт `sdlc_common.patch_hunks`. */
export function patchHunks(patch: string): HunkLine[] {
  const out: HunkLine[] = [];
  let path: string | null = null;
  let inHeader = false;
  let newLn = 0;
  let oldLn = 0;
  for (const ln of patch.split(/\r?\n/)) {
    const m = DIFF_GIT.exec(ln);
    if (m !== null) {
      path = unquoteGitPath(m[3] ?? m[4] ?? '');
      inHeader = true;
      continue;
    }
    if (path === null) continue;
    if (inHeader) {
      if (ln.startsWith('+++ ') && ln.slice(4).trim() !== '/dev/null') {
        const tgt = unquoteGitPath(ln.slice(4).trim());
        path = tgt.startsWith('b/') ? tgt.slice(2) : tgt;
      }
      if (ln.startsWith('@@')) inHeader = false;
      else continue;
    }
    if (ln.startsWith('@@')) {
      const mm = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      oldLn = mm === null ? 0 : Number(mm[1]);
      newLn = mm === null ? 0 : Number(mm[2]);
    } else if (ln.startsWith('+')) {
      out.push({ path, line: newLn, sign: '+', text: ln.slice(1) });
      newLn++;
    } else if (ln.startsWith('-')) {
      out.push({ path, line: oldLn, sign: '-', text: ln.slice(1) });
      oldLn++;
    } else if (!ln.startsWith('\\')) {
      newLn++;
      oldLn++;
    }
  }
  return out;
}

export function diffstat(patch: string): Diffstat {
  const files = patchFiles(patch);
  const perFile: Diffstat['per_file'] = {};
  for (const f of files) {
    perFile[f.path] = { added: f.added, deleted: f.removed, new: f.new, deleted_entirely: f.deleted };
  }
  return {
    files: files.length,
    added: files.reduce((s, f) => s + f.added, 0),
    deleted: files.reduce((s, f) => s + f.removed, 0),
    paths: files.map((f) => f.path).sort(),
    deleted_paths: files.filter((f) => f.deleted).map((f) => f.path).sort(),
    per_file: perFile,
  };
}
