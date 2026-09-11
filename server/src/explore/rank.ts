/**
 * Ранжирование файлов-кандидатов и кандидатов на переиспользование по ключевым словам
 * задачи. Чистые функции; веса — эвристика, и это сказано модели: список кандидатов —
 * подсказка, а не карта, файл вне списка модель вправе назвать в «Границах разведки».
 */

import { posix } from 'node:path';

import { tsSpecifierCandidatesPosix } from '../fs/tsSpecifier.ts';
import { callersOf } from './symbols.ts';
import type { Keywords } from './keywords.ts';
import type { ExploreIndex, IndexedFile } from './types.ts';

export interface RankedFile {
  file: IndexedFile;
  score: number;
  /** Почему файл в кандидатах — человеку и модели одинаково. */
  why: string[];
}

const WEIGHT = {
  pathExact: 8,
  fileName: 5,
  symbolDeclared: 4,
  symbolMentioned: 1,
  word: 1,
  wordCap: 6,
  testOfTop: 2,
} as const;

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1).toLowerCase();
}

/** Верх списка — файлы, которые задача называет буквально; ниже — по совпадениям слов. */
export function rankFiles(index: ExploreIndex, kw: Keywords, max = 8): RankedFile[] {
  const paths = new Set(kw.paths.map(normPath));
  const names = new Set(kw.paths.map(baseName));
  const scored: RankedFile[] = [];

  for (const file of index.files) {
    if (file.kind === 'doc') continue;
    let score = 0;
    const why: string[] = [];
    const p = normPath(file.path);
    if (paths.has(p)) {
      score += WEIGHT.pathExact;
      why.push('путь назван в задаче');
    } else if (names.has(baseName(file.path))) {
      score += WEIGHT.fileName;
      why.push('имя файла названо в задаче');
    }
    const declared = new Set(file.symbols.map((s) => s.name));
    const hitDeclared = kw.symbols.filter((s) => declared.has(s));
    if (hitDeclared.length > 0) {
      score += WEIGHT.symbolDeclared * hitDeclared.length;
      why.push(`объявляет ${hitDeclared.join(', ')}`);
    }
    const mentioned = kw.symbols.filter((s) => !declared.has(s) && file.text.includes(s));
    if (mentioned.length > 0) {
      score += WEIGHT.symbolMentioned * mentioned.length;
      why.push(`упоминает ${mentioned.join(', ')}`);
    }
    const lower = file.text.toLowerCase();
    const words = kw.words.filter((w) => lower.includes(w));
    if (words.length > 0) {
      score += Math.min(WEIGHT.wordCap, WEIGHT.word * words.length);
      why.push(`слова задачи: ${words.slice(0, 5).join(', ')}`);
    }
    if (score > 0) scored.push({ file, score, why });
  }

  // Тест, упоминающий символы файла из верха списка, — тоже кандидат: там видно, как
  // проект проверяет то, что предстоит менять.
  const top = scored
    .filter((r) => r.file.kind === 'code')
    .sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : 1))
    .slice(0, 3);
  for (const r of scored) {
    if (r.file.kind !== 'test') continue;
    const names = top.flatMap((t) => t.file.symbols.filter((s) => s.exported).map((s) => s.name));
    if (names.some((n) => r.file.text.includes(n))) {
      r.score += WEIGHT.testOfTop;
      r.why.push('тест символов из верха списка');
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
    .slice(0, max);
}

export interface ReuseCandidate {
  path: string;
  symbol: string;
  signature: string;
  /** Сколько мест уже вызывают символ — довод, что он «живой». */
  callers: number;
  why: string[];
}

/** Файлы, которые файл импортирует относительным путём, — те, что есть в индексе. */
function importedFiles(index: ExploreIndex, file: IndexedFile): IndexedFile[] {
  const byPath = new Map(index.files.map((f) => [f.path, f] as const));
  const out: IndexedFile[] = [];
  for (const m of file.text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1]!;
    const base = posix.normalize(posix.join(posix.dirname(file.path), spec));
    // Тот же список форм, что у резолвера Write/Edit и гейта «Импорты»
    // (`fs/tsSpecifier.ts`): раньше здесь была третья независимая копия — без `.tsx` и
    // без замены `.js → .ts» (ревью code-review-all, 2026-09-11). Первый элемент списка —
    // сам `base` без расширения — по индексу файлов не ищется: индекс хранит файлы, а не
    // каталоги, и точное совпадение без расширения там не встречается.
    for (const cand of tsSpecifierCandidatesPosix(base).slice(1)) {
      const f = byPath.get(cand);
      if (f !== undefined && !out.includes(f)) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

/**
 * Что из нужного УЖЕ написано: экспортируемые символы файлов верха списка и файлов, которые
 * они импортируют. Символ, названный в задаче, идёт первым — задача сама указала, что его
 * трогать или вызывать.
 */
export function reuseCandidates(index: ExploreIndex, ranked: readonly RankedFile[], kw: Keywords, max = 12): ReuseCandidate[] {
  const seen = new Set<string>();
  const out: (ReuseCandidate & { rank: number })[] = [];
  const named = new Set(kw.symbols);
  const wanted = new Set(kw.words);

  const consider = (file: IndexedFile, rank: number, viaImport: boolean): void => {
    if (file.kind !== 'code') return;
    for (const s of file.symbols) {
      if (!s.exported) continue;
      const key = `${file.path}:${s.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const why: string[] = [];
      if (named.has(s.name)) why.push('назван в задаче');
      const lowered = s.name.toLowerCase();
      if ([...wanted].some((w) => lowered.includes(w))) why.push('имя совпадает со словом задачи');
      if (viaImport) why.push('импортируется файлом-кандидатом');
      const callers = callersOf(index, s.name, file.path).length;
      out.push({ path: file.path, symbol: s.name, signature: s.signature, callers, why, rank });
    }
  };

  ranked.forEach((r, i) => consider(r.file, i, false));
  ranked.forEach((r, i) => {
    for (const imp of importedFiles(index, r.file)) consider(imp, i, true);
  });

  const score = (c: ReuseCandidate & { rank: number }): number =>
    (named.has(c.symbol) ? 5 : 0) + (c.why.includes('имя совпадает со словом задачи') ? 2 : 0) - c.rank * 0.1 + Math.min(c.callers, 3) * 0.5;
  return out
    .sort((a, b) => score(b) - score(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.symbol < b.symbol ? -1 : 1))
    .slice(0, max)
    .map(({ rank: _rank, ...rest }) => rest);
}
