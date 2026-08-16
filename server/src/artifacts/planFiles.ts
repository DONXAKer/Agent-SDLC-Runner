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

const SECTION_RE = /^#{1,6}\s.*files_to_touch/im;
const NEXT_HEADING_RE = /^#{1,6}\s/m;
/** Строка, с которой начинается перечисление исключённых путей. */
const EXCLUDED_RE = /^.*Из задачи исключено/im;
/** Разделительная строка markdown-таблицы: `|---|---|`. */
const TABLE_SEPARATOR = /^\|[\s|:-]+\|?$/;

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
  if (t.includes('/')) return true;
  if (t.includes('.')) return true;
  return EXTENSIONLESS.has(t.toLowerCase());
}

/** Из строки таблицы берём ячейку, похожую на путь; закавыченная имеет приоритет. */
function pathFromRow(line: string): string | null {
  const cells = line
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '');

  const backticked = cells.find((c) => c.startsWith('`') && looksLikePath(c));
  if (backticked !== undefined) return clean(backticked);

  const plain = cells.find((c) => looksLikePath(c));
  return plain === undefined ? null : clean(plain);
}

export function extractFilesToTouch(planText: string): string[] {
  const start = SECTION_RE.exec(planText);
  if (start === null) return [];

  const rest = planText.slice(start.index + start[0].length);
  const next = NEXT_HEADING_RE.exec(rest);
  let section = next === null ? rest : rest.slice(0, next.index);

  const excluded = EXCLUDED_RE.exec(section);
  if (excluded !== null) section = section.slice(0, excluded.index);

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
