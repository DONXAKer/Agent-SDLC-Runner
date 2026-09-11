/**
 * Индекс проекта для разведки (этап 2) — данные, которые рантайм собирает сам и подаёт
 * модели готовыми вместо права искать.
 *
 * Зачем. Замер 2026-09-11 (`freeship`, `docs/model-runs.md`): пять локальных моделей встали
 * на `explore`; у `qwen3-8b` 25 вызовов — `Task`, `Write`, `Edit`, `FinalizeArtifact` — и НИ
 * ОДНОГО `Read`/`Glob`/`Grep`. Разведка без чтения кода. Право искать у модели было, но
 * порог «позвать инструмент» у этого класса лежит ниже порога «понять задачу» — тот же
 * урок, что у `formFill` и `stepFill`. Индекс переносит навигацию на рантайм: дерево,
 * символы, кандидаты по ключевым словам задачи, вызывающие, кандидаты механизмов по осям
 * прод-готовности. Модели остаётся суждение — «что там сейчас», «что меняем».
 *
 * Всё, кроме `tree.ts`, — чистые функции без I/O.
 */

export interface SymbolDecl {
  name: string;
  /** Строка объявления, с 1. */
  line: number;
  exported: boolean;
  /** Строка объявления как есть, обрезанная — для карточки кандидата. */
  signature: string;
}

export type FileKind = 'code' | 'test' | 'doc';

export interface IndexedFile {
  /** Путь от корня проекта, posix. */
  path: string;
  bytes: number;
  lines: number;
  text: string;
  kind: FileKind;
  symbols: SymbolDecl[];
}

export interface ExploreIndex {
  root: string;
  files: IndexedFile[];
  /** Что не вошло по потолкам — честно, чтобы карта не выглядела полной. */
  skipped: { files: number; bytes: number };
}

export interface TreeLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/**
 * Потолки обхода. Не про окно модели — про память и время: индекс держит тексты файлов
 * для карточек и вызывающих, и репозиторий на десятки мегабайт кода в него не нужен.
 */
export const TREE_LIMITS: TreeLimits = { maxFiles: 1500, maxFileBytes: 200_000, maxTotalBytes: 4_000_000 };

/** Максимальная длина строки объявления в карточке. */
export const SIGNATURE_MAX = 160;
