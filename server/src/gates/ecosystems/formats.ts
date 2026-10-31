/**
 * Форматные линтеры: проверки конфигов и документации ПОФАЙЛОВО, без привязки к
 * экосистеме модуля.
 *
 * Отдельный реестр от экосистем, потому что вопрос другой: экосистемный линт отвечает
 * «идиоматичен ли код модуля» и ищется по манифесту каталога, а здесь — «корректен ли
 * формат файла», и ответ зависит только от имени/расширения самого файла. `.md`/`.yaml`
 * не входят ни в один `codeExt`, а у `Dockerfile` нет расширения вовсе: через
 * модульный линт они не проходят по построению (фильтр `codeExt` в гейте линта), и это
 * пересечение запрещено инвариантом — проверяется тестом.
 *
 * Здесь только данные и чистые функции: ни файловой системы, ни процессов. I/O живёт в
 * `builtin/index.ts`, как и у экосистем.
 */

export interface FileLinter {
  /** Ключ для сообщений гейта. */
  id: string;
  /** Человеческое имя — попадает в текст гейта. */
  label: string;
  /**
   * Точные имена файлов (без путей, в исходном регистре) — для форматов без
   * расширения: `Dockerfile` расширением не описать.
   */
  names?: readonly string[];
  /** Расширения с точкой, в нижнем регистре. */
  exts?: readonly string[];
  /**
   * Внешний линтер. `undefined` — формат проверяется нативно (поле `parse`), и исхода
   * «⏭ инструмент не найден» у такой проверки не бывает. Одно из `cmd`/`parse`
   * обязано быть задано — иначе запись ничего не проверяет.
   */
  cmd?: string;
  /** Аргументы ДО списка файлов; пути подставляются гейтом отдельными аргументами. */
  args?: readonly string[];
  /**
   * Нативная проверка валидности: текст → описание ошибки, `null` — файл парсится.
   * Проверка рантаймом, без внешнего инструмента: для формата, чей парсер уже есть в
   * рантайме (JSON), это строго честнее ⏭ «линтер не установлен».
   */
  parse?: (text: string) => string | null;
}

/**
 * JSONC-терпимая нормализация: комментарии (`//`, `/* *\/`) и висячие запятые —
 * законная часть экосистемы JSON-файлов (tsconfig, .vscode, .code-workspace), и строгий
 * `JSON.parse` краснел бы на исправном `tsconfig.json`. Сканер, а не регэксп: запятую
 * внутри строки от запятой между значениями отличает только состояние «в строке ли мы».
 */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      // Висячая запятая перед закрывающей скобкой — отбрасываем. Позиции в выводе
      // съезжают, но этот проход лишь отвечает «валиден ли JSONC»; позицию ошибки даёт
      // строгий разбор в `validateJson`.
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Валидность JSON: скобки, запятые, строки. Сначала строгий разбор — его сообщение с
 * позицией и уходит в улику; если строгий не прошёл, проверяем как JSONC — файл с
 * комментариями и висячими запятыми исправен по соглашениям своих инструментов.
 */
export function validateJson(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (strict) {
    try {
      JSON.parse(stripJsonc(text));
      return null;
    } catch {
      return strict instanceof Error ? strict.message : String(strict);
    }
  }
}

/**
 * Только инструменты с устоявшимся стандартом и пофайловым запуском, плюс нативная
 * проверка там, где парсер уже есть в рантайме. TOML и ini здесь нет намеренно: ни
 * парсера в рантайме, ни общепринятого пофайлового инструмента у них нет, и выдуманная
 * проверка краснела бы по чужой причине.
 */
export const FILE_LINTERS: readonly FileLinter[] = [
  {
    id: 'json',
    label: 'JSON',
    exts: ['.json'],
    // Парсер уже в рантайме: проверка не зависит от установленных инструментов.
    parse: validateJson,
  },
  {
    id: 'yaml',
    label: 'YAML',
    exts: ['.yml', '.yaml'],
    cmd: 'yamllint',
    // `-f parsable`: строки вида `файл:строка:колонка: [уровень] текст` — их хвост
    // читается в улике гейта без расшифровки цветного вывода.
    args: ['-f', 'parsable'],
  },
  {
    id: 'dockerfile',
    label: 'Dockerfile',
    names: ['Dockerfile'],
    exts: ['.dockerfile'],
    cmd: 'hadolint',
    args: [],
  },
  {
    id: 'markdown',
    label: 'Markdown',
    exts: ['.md', '.markdown'],
    cmd: 'markdownlint',
    args: [],
  },
];

/**
 * Линтер формата для файла — по точному имени, затем по расширению. `null` — формат
 * неизвестен или линтера для него нет: молчание честнее красного по чужому формату.
 */
export function fileLinterFor(file: string): FileLinter | null {
  const base = file.slice(file.lastIndexOf('/') + 1);
  for (const linter of FILE_LINTERS) {
    if (linter.names?.includes(base) === true) return linter;
  }
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot).toLowerCase();
  return FILE_LINTERS.find((l) => l.exts?.includes(ext) === true) ?? null;
}
