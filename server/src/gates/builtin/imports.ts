/**
 * Гейт «Импорты»: относительный путь специфайера без явного расширения — под проект,
 * где TypeScript исполняется напрямую Node (нет tsconfig.json, значит нет компилятора и
 * бандлера, которые сами дописывают расширение при резолюции).
 *
 * Найден живым замером трёх моделей подряд (`docs/model-runs.md`, 2026-09-10:
 * `qwen3-coder-30b`, `granite-3.2-8b`, `gemma-4-e4b`): все три написали `'./money'` или
 * `'../tariffs'` вместо `'./money.ts'`/`'../src/tariffs.ts'`. Резолвер Write/Edit-времени
 * (`exec/tools/index.ts: verifyTsImports`) терпим к этому нарочно — целевой проект чужой,
 * может резолвить импорт без расширения своим бандлером/tsc, и эта терпимость там законна
 * (та проверка — про совпадение ИМЁН экспорта, не про формат пути). Формат пути —
 * ОТДЕЛЬНЫЙ вопрос, специфичный для конкретного целевого проекта, и решает его проект
 * через `.sdlc/gates.md`, не раннер безусловно для всех.
 *
 * Только правило, без файловой системы: список изменённых файлов, их содержимое и
 * резолвер специфайера подаёт вызывающий (`gates/builtin/index.ts`).
 */

export interface ImportExtensionProblem {
  file: string;
  specifier: string;
  /** Куда путь резолвится ТОЛЬКО достройкой расширения — относительно корня проекта. */
  resolvedAs: string;
}

/** `exact: false` — специфайер сам по себе не резолвится, найден только достройкой. */
export type SpecifierResolution = { exact: boolean; resolvedAs: string } | null;

// Две формы: с `from` (именованный/дефолтный/namespace/их сочетание — клаузу перед `from`
// не разбираем по видам, хватает «не кавычка и не `;`») и без него (`import './x'` — только
// побочный эффект, `from` там синтаксически невозможен). Раньше был один паттерн, требующий
// именно `{ ... } from` — молчал на `import add from './m'`, `import * as m from './m'`,
// `import './m'`: живой замер поймал ровно этот класс, а находок из-за него не было
// (docs/model-runs.md, 2026-09-10 — гейт зеленел на дефолтных/namespace-импортах).
const IMPORT_FROM_RE = /import\s+(?:type\s+)?[^'";]*?\bfrom\s+['"](\.[^'"]+)['"]/g;
const IMPORT_BARE_RE = /import\s+['"](\.[^'"]+)['"]/g;

/**
 * Специфайеры относительных импортов, встречающиеся в тексте — построчно, без учёта того,
 * добавлена ли строка в diff'е: фильтрацию по добавленным строкам делает вызывающий.
 */
export function relativeImportSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_FROM_RE)) out.push(m[1]!);
  for (const m of content.matchAll(IMPORT_BARE_RE)) out.push(m[1]!);
  return out;
}

/**
 * Находки «путь без расширения» для одного файла: специфайер подаётся резолверу, который
 * знает файловую систему целевого проекта; здесь — только решение, считать ли находкой.
 */
export function extensionProblems(
  file: string,
  content: string,
  resolve: (specifier: string) => SpecifierResolution,
): ImportExtensionProblem[] {
  const out: ImportExtensionProblem[] = [];
  for (const specifier of relativeImportSpecifiers(content)) {
    const resolved = resolve(specifier);
    if (resolved === null || resolved.exact) continue;
    out.push({ file, specifier, resolvedAs: resolved.resolvedAs });
  }
  return out;
}
