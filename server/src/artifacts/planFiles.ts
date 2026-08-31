/**
 * Извлечение `files_to_touch` из плана.
 *
 * Этот список — вход PlanScope: ровно в эти файлы агенту разрешено писать на этапе 5.
 * Ошибка стоит дорого в обе стороны, и обе наблюдались:
 *
 *  - лишний путь в списке расширяет право на запись. Поэтому хвост секции начиная со
 *    строки «Из задачи исключено» вырезается: там перечислены пути, которые в
 *    `files_to_touch` входить **не должны**;
 *  - пропущенный путь делает законную запись невозможной. Наивный разбор «первая непустая
 *    ячейка строки таблицы» ломался на нумерованной таблице (`| 1 | src/a.ts | …`) и молча
 *    выбрасывал имена без расширения (`Makefile`, `Dockerfile`), после чего виток вставал
 *    намертво с сообщением «files_to_touch пуст».
 */

import { splitRow } from '../md/table.ts';

const SECTION_RE = /^#{1,6}\s.*files_to_touch/im;
const NEXT_HEADING_RE = /^#{1,6}\s/m;
/** Строка, с которой начинается перечисление исключённых путей. */
const EXCLUDED_RE = /^.*Из задачи исключено/im;
/** Разделительная строка markdown-таблицы: `|---|---|`. */
const TABLE_SEPARATOR = /^\|[\s|:-]+\|?$/;

/**
 * Артефакты витка, названные КОРОТКИМ именем: в прозе плана они поминаются постоянно
 * («список совпадает с „Что придётся тронуть“ из `intent.md`»), и без этого списка такое
 * упоминание становилось четвёртым «путём плана». Последствия были в обе стороны сразу:
 * PlanScope выдавал право писать в артефакт человека, а гейт «Scope: пути плана без
 * правок» краснел на пути, который править никто и не собирался, — вердикт не мог
 * позеленеть в принципе (пойман r21: «путей плана без правок: 1 из 4» при трёх реально
 * тронутых). Путь `.sdlc/…` отсекается отдельным правилом ниже — здесь именно короткие
 * имена, какими артефакты зовут в тексте.
 */
const WITOK_ARTIFACTS = new Set([
  'intent.md',
  'readiness.md',
  'exploration-report.md',
  'clarification-report.md',
  'plan.md',
  'handoff.md',
  'gates.md',
]);
const WITOK_ARTIFACT_RE = /^(chunk-\d+-journal\.md|verification-report-\d+-attempt-\d+\.md|self-review-\d+-attempt-\d+\.md|chunk-\d+-attempt-\d+-(diff\.patch|tests\.txt))$/i;

/** Файлы без расширения, которые встречаются в планах как обычные цели правки. */
const EXTENSIONLESS = new Set([
  'makefile',
  'dockerfile',
  'jenkinsfile',
  'gemfile',
  'rakefile',
  'procfile',
  'vagrantfile',
  'brewfile',
  'justfile',
  'license',
  'changelog',
  'readme',
  'notice',
  'codeowners',
]);

function clean(s: string): string {
  return s.trim().replace(/^`|`$/g, '').trim();
}

/** Похоже ли на путь, а не на номер строки, прозу или имя символа. */
function looksLikePath(raw: string): boolean {
  const t = clean(raw);
  if (t === '' || /\s/.test(t)) return false;
  if (t.includes('‹') || t.includes('›')) return false;
  if (/^[#\d.,)]+$/.test(t)) return false; // номер строки таблицы
  if (t.includes('::')) return false; // `путь:символ` — форма отчёта разведки
  if (t === '.sdlc' || t.startsWith('.sdlc/')) return false; // артефакты процесса
  const base = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
  if (WITOK_ARTIFACTS.has(base) || WITOK_ARTIFACT_RE.test(base)) return false;
  if (t.includes('/')) return true;
  if (t.includes('.')) return true;
  return EXTENSIONLESS.has(t.toLowerCase());
}

/** Из строки таблицы берём ячейку, похожую на путь; закавыченная имеет приоритет. */
function pathFromRow(line: string): string | null {
  // Общий разборщик, а не split('|'): экранированная `\|` в ячейке рвала колонку —
  // тот же класс, что чинился в humanFacts (ревью, class sweep).
  const cells = splitRow(line).filter((c) => c !== '');

  const backticked = cells.find((c) => c.startsWith('`') && looksLikePath(c));
  if (backticked !== undefined) return clean(backticked);

  const plain = cells.find((c) => looksLikePath(c));
  return plain === undefined ? null : clean(plain);
}

const ADDED_BEYOND_RE = /^(.*\*\*Добавлено сверх разведки:\*\*.*)$/m;

/**
 * Дописывает путь в `files_to_touch` плана после одобренного `request_scope_extension`
 * (этап 5, реализация: `Run.ts`).
 *
 * Строка ставится СРАЗУ после «Добавлено сверх разведки», а не строкой новой таблицы:
 * `extractFilesToTouch` уже читает путь в обратных кавычках вне таблицы, если он лежит
 * до «Из задачи исключено» — переиспользуем это, а не заводим второй парсер для того же
 * файла. Маркер обязан существовать: `plan.md` копируется из `plan.template.md`, где эта
 * строка есть по форме; отсутствие — признак вручную покалеченного файла, чинить который
 * подстановкой означало бы гадать, куда именно.
 */
/** И статичный маркер, и уже вставленная строка расширения — оба годятся как место для
 * следующей вставки, см. комментарий в `appendScopeExtension` про порядок. */
const ANCHOR_RE = /^(.*\*\*Добавлено сверх разведки:\*\*.*|- \*\*Расширено:\*\*.*)$/gm;

/**
 * Границы секции `files_to_touch` в тексте плана — общие для `extractFilesToTouch` (парсит
 * пути) и `appendScopeExtension` (ищет якорь для вставки): оба обязаны видеть РОВНО одну и
 * ту же зону документа, иначе якорь может совпасть там, где парсер путей уже не смотрит
 * (например, в «Из задачи исключено»), и вставленная запись не попадёт в allowlist.
 */
function filesToTouchSection(planText: string): { start: number; section: string } | null {
  const start = SECTION_RE.exec(planText);
  if (start === null) return null;
  const sectionStart = start.index + start[0].length;
  const rest = planText.slice(sectionStart);
  const next = NEXT_HEADING_RE.exec(rest);
  let section = next === null ? rest : rest.slice(0, next.index);

  const excluded = EXCLUDED_RE.exec(section);
  if (excluded !== null) section = section.slice(0, excluded.index);

  return { start: sectionStart, section };
}

export function appendScopeExtension(planText: string, path: string, note: string): string | null {
  if (!ADDED_BEYOND_RE.test(planText)) return null;
  const line = `- **Расширено:** \`${path}\` — ${note}`;

  // Якорь ищем ТОЛЬКО внутри секции files_to_touch — та же граница, что использует
  // `extractFilesToTouch`. Без неё тот же паттерн мог совпасть где угодно в документе
  // (вручную скопированный пример методологии, приложение) и вставить запись не в ту
  // секцию — маркер обязан быть найден именно там, где реально живёт список путей.
  const boundary = filesToTouchSection(planText);
  if (boundary === null) return null;
  const { start: sectionStart, section } = boundary;

  // Вставляем ПОСЛЕ ПОСЛЕДНЕЙ уже добавленной записи, а не сразу за статичным маркером:
  // `replace` с немодифицированным паттерном всегда матчит маркер (текст самой вставленной
  // строки этот же паттерн не содержит), поэтому при двух и более `request_scope_extension`
  // за виток вторая запись вставала бы МЕЖДУ маркером и первой — порядок в файле получался
  // бы обратным (LIFO) хронологии одобрений. Ищем последнее совпадение (маркер ИЛИ
  // последняя вставленная строка) и вставляем сразу за ним.
  let lastMatch: RegExpExecArray | null = null;
  for (const m of section.matchAll(ANCHOR_RE)) lastMatch = m;
  if (lastMatch === null) return null;

  const insertAt = sectionStart + lastMatch.index + lastMatch[0].length;
  return `${planText.slice(0, insertAt)}\n${line}${planText.slice(insertAt)}`;
}

export function extractFilesToTouch(planText: string): string[] {
  const boundary = filesToTouchSection(planText);
  if (boundary === null) return [];
  const { section } = boundary;

  const lines = section.split('\n');
  // Строка-разделитель отмечает конец шапки таблицы: заголовки («Путь», «Что делаем»)
  // путями не являются, и без этого «Зачем» попадало в allowlist.
  const separatorAt = lines.findIndex((l) => TABLE_SEPARATOR.test(l.trim()));

  const out: string[] = [];
  const add = (raw: string | null): void => {
    if (raw === null) return;
    const t = clean(raw);
    if (looksLikePath(t) && !out.includes(t)) out.push(t);
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('|')) {
      if (TABLE_SEPARATOR.test(trimmed)) return;
      if (separatorAt >= 0 && idx < separatorAt) return; // шапка таблицы
      add(pathFromRow(trimmed));
      return;
    }

    // Вне таблицы берём только пути в обратных кавычках — проза в allowlist не попадает.
    const re = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) add(m[1] ?? '');
  });

  return out;
}
