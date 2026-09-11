/**
 * Символы файла и их вызывающие — грубым разбором текста, не компилятором.
 *
 * Формы объявлений берутся из реестра экосистем (`declaredFunctionNames`) — то же знание,
 * что у гейта «Дубли хелперов»; для TypeScript/JavaScript сверх этого — `export const/class/
 * interface/type/enum` и `export { … }` (`namedExportsOf`, тот же разбор, что у проверки
 * импортов `verifyTsImports`). Недобор возможен, перебора нет: символ, которого разбор не
 * увидел, просто не попадёт в кандидаты — модель напишет его в «Границы разведки».
 */

import { namedExportsOf } from '../exec/tools/index.ts';
import { declaredFunctionNames } from '../gates/ecosystems/index.ts';
import { escapeRe } from '../artifacts/artifact.ts';
import { SIGNATURE_MAX, type ExploreIndex, type IndexedFile, type SymbolDecl } from './types.ts';

const TS_LIKE = /\.(?:[cm]?[jt]sx?)$/i;
/**
 * Объявление верхнего уровня (без отступа) — экспортируемое или нет: локальная `const` внутри
 * функции стоит с отступом и сюда не попадает, а модульная константа вроде `WEIGHT_LIMITS_G`
 * — то, что карточка обязана показать: план часто меняет именно её.
 */
const TS_DECL_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|class|interface|type|enum|abstract\s+class|function\s*\*?)\s+([A-Za-z_$][\w$]*)/;

/** Объявленные в файле символы — по одному на имя, в порядке первого появления. */
export function declaredSymbols(text: string, path: string): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const seen = new Set<string>();
  const tsLike = TS_LIKE.test(path);
  const exportedNames = tsLike ? namedExportsOf(text) : new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const names = declaredFunctionNames(line);
    if (tsLike) {
      const m = TS_DECL_RE.exec(line);
      if (m !== null && m[1] !== undefined && !names.includes(m[1])) names.push(m[1]);
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Для TS/JS видимость решает слово `export` — узнаётся точно. Для остальных
      // экосистем (Python/Go/Rust/Ruby/…) `declaredFunctionNames` не несёт признака
      // видимости языка (общий регистр форм объявлений по всем экосистемам сразу, без
      // разметки «какая именно»), и до этой правки ВСЕ их символы считались приватными —
      // `reuseCandidates` на любом не-TS проекте был пуст по построению (ревью
      // code-review-all, 2026-09-11). Ведущее подчёркивание — распространённая через
      // языки конвенция «приватное» (Python, Ruby); для остального недобор безопаснее
      // перебора («Недобор возможен, перебора нет» — докстринг файла), но полный
      // блэкаут пяти языков дороже редкой лишней Rust-строки без `pub`.
      const exported = tsLike ? /^\s*export\b/.test(line) || exportedNames.has(name) : !name.startsWith('_');
      out.push({ name, line: i + 1, exported, signature: line.trim().slice(0, SIGNATURE_MAX) });
    }
  }
  return out;
}

/** Ближайшее объявление выше строки — «в каком символе это место». `null` — выше нет ни одного. */
export function enclosingSymbol(file: IndexedFile, line: number): string | null {
  let found: string | null = null;
  for (const s of file.symbols) {
    if (s.line > line) break;
    found = s.name;
  }
  return found;
}

export interface Caller {
  path: string;
  /** Символ, внутри которого стоит вызов; `null` — верхний уровень файла. */
  symbol: string | null;
  line: number;
}

/**
 * Где символ вызывается или импортируется — кроме файла, где он объявлен. Порядок
 * детерминирован (файлы индекса уже отсортированы), потолок — чтобы `add`/`get` не
 * раздували карточку сотней строк. Одно место на файл: карточке нужен адрес, а не список.
 */
export function callersOf(index: ExploreIndex, symbol: string, exceptPath: string, max = 5): Caller[] {
  const out: Caller[] = [];
  const call = new RegExp(`(^|[^\\w$.])${escapeRe(symbol)}\\s*\\(`);
  // `\b` не работает на границе с кириллицей (CLAUDE.md — тот же класс бага, что уже
  // ловился в `gatesFile.ts`/`reviewFill.ts`): `\bконстант\b` не матчит вовсе, если по
  // обе стороны от `\b` не-ASCII-буква. Та же охрана, что у `call` выше — нешрифтовый
  // символ вместо `\b` (ревью code-review-all, 2026-09-11, воспроизведено прогоном).
  const imported = new RegExp(`^\\s*import\\b[^;]*[^\\w$]${escapeRe(symbol)}(?:[^\\w$]|$)`);
  for (const f of index.files) {
    if (f.path === exceptPath || f.kind === 'doc') continue;
    // Дешёвая отсечка ДО дорогого разбора: `reuseCandidates` зовёт `callersOf` для
    // КАЖДОГО экспортируемого символа файлов-кандидатов, и без неё каждый такой вызов
    // сплитил и построчно гонял regex по ВСЕМ файлам индекса — O(символов × строк
    // корпуса) синхронно внутри `Run.preparePrompt` (ревью code-review-all, 2026-09-11).
    // Файл, не содержащий имени символа вообще, не может дать ни вызова, ни импорта —
    // `String.includes` отсекает подавляющее большинство файлов без единого regex.
    if (!f.text.includes(symbol)) continue;
    const lines = f.text.split(/\r?\n/);
    // Место ВЫЗОВА важнее строки импорта: «`tariffs.ts:priceFor`» говорит, где символ
    // работает, «`tariffs.ts:9`» — только что он подключён.
    let hit: Caller | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (call.test(l)) {
        hit = { path: f.path, symbol: enclosingSymbol(f, i + 1), line: i + 1 };
        break;
      }
      if (hit === null && imported.test(l)) hit = { path: f.path, symbol: enclosingSymbol(f, i + 1), line: i + 1 };
    }
    if (hit !== null) out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}
