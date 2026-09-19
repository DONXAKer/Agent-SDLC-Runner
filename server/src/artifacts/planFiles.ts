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

import { hasPlaceholder } from './artifact.ts';
import { LEADING_PIPE_SEPARATOR_RE, h2SectionRanges, splitRow } from '../md/table.ts';

const SECTION_RE = /^#{1,6}\s.*files_to_touch/im;
const NEXT_HEADING_RE = /^#{1,6}\s/m;
/** Строка, с которой начинается перечисление исключённых путей. */
const EXCLUDED_RE = /^.*Из задачи исключено/im;

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

/**
 * Символы, которых не бывает в путях этого проекта, но которые проходили прежнюю проверку
 * только потому, что строка содержала `/` где-то ещё. Живой пример (`security-bait`,
 * серия `test21`, 2026-09-17): `ministral` вписал в `files_to_touch` куски сигнатуры вызова
 * вместо путей — `/sendNotification.*to,phone,text/` и `/logEvent/;logEvent` — оба приняты
 * старой проверкой (есть `/`), оба отклонены политикой `pathScope` уже на этапе `chunk`, на
 * ход дороже. Список — не полный алфавит «плохих» символов, а ровно то, что уже наблюдалось
 * в мусоре: регэксп-мета (`*`) и разделители перечисления/аргументов (`,` `;`).
 */
const NOT_PATH_CHARS = /[*,;]/;

/** Похоже ли на путь, а не на номер строки, прозу или имя символа. */
function looksLikePath(raw: string): boolean {
  const t = clean(raw);
  if (t === '' || /\s/.test(t)) return false;
  if (t.includes('‹') || t.includes('›')) return false;
  if (/^[#\d.,)]+$/.test(t)) return false; // номер строки таблицы
  if (t.includes('::')) return false; // `путь:символ` — форма отчёта разведки
  if (NOT_PATH_CHARS.test(t)) return false; // обрывок сигнатуры/перечисления, не путь
  if (t === '.sdlc' || t.startsWith('.sdlc/')) return false; // артефакты процесса
  const base = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
  if (WITOK_ARTIFACTS.has(base) || WITOK_ARTIFACT_RE.test(base)) return false;
  if (t.includes('/')) return true;
  if (t.includes('.')) return true;
  return EXTENSIONLESS.has(t.toLowerCase());
}

/**
 * Объявлен ли путь строки как будущий — то есть его отсутствие в дереве законно.
 *
 * Перенесена сюда из `server/src/run/stages/explore.ts` (`declaredAsNew`, до 2026-09-17):
 * `FormFillExecutor.ts` нуждается в той же проверке для добора `files_to_touch`, но
 * `explore.ts` импортирует `ExploreExecutor.ts`, который импортирует `FormFillExecutor.ts`
 * — прямой импорт создал бы цикл. `stages/explore.ts` теперь ре-экспортирует эту функцию
 * без изменения тела; внешний API (`server/src/run/stages.ts`) не меняется.
 *
 * Словарь — формы, которыми это пишут люди и модели: «новый», «отсутствует»,
 * «не существует», «будет создан», «создать», «создаётся». Проверяется каждая ячейка
 * строки: пометка стоит там, где автору удобно, а не в колонке, которую мы назначили.
 */
export function declaredAsNew(row: readonly string[]): boolean {
  return row.some((cell) => {
    const t = (cell ?? '').toLowerCase().replace(/ё/g, 'е');
    if (/(^|[^\p{L}])нов/u.test(t)) return true;
    if (/(^|[^\p{L}])создат|(^|[^\p{L}])создан|(^|[^\p{L}])создает/u.test(t)) return true;
    return /отсутству|не\s+существу|нет\s+в\s+дереве|пока\s+нет/u.test(t);
  });
}

/**
 * Из строки таблицы берём ячейку, похожую на путь; закавыченная имеет приоритет.
 *
 * Экспортирована для `FormFillExecutor.ts` (добор `files_to_touch` на «путь по форме, но
 * несуществующий», серия test21): наивный разбор «первая непустая ячейка» ломается на той
 * же нумерованной таблице (`| 1 | src/a.ts | … |`), от которой этот разборщик и защищает —
 * см. докстринг файла выше. Второй копии той же логики заводить нельзя.
 */
export function pathFromRow(line: string): string | null {
  // Общий разборщик, а не split('|'): экранированная `\|` в ячейке рвала колонку —
  // тот же класс, что чинился в humanFacts (ревью, class sweep).
  const cells = splitRow(line).filter((c) => c !== '');
  return pathFromCells(cells);
}

/**
 * То же правило выбора ячейки, что у `pathFromRow`, но для уже разобранных ячеек —
 * нужно `FormFillExecutor.ts` в компактном режиме, где строка `files_to_touch` приходит
 * не сырой markdown-строкой, а разобранной записью (`Record<string, string>` из
 * `sheet.ts::parseRecordRows`, значения через `Object.values`), закавыченной ячейки в ней
 * не бывает — но правило «первая похожая на путь» то же самое, и заводить для него
 * второй разборщик не нужно.
 */
export function pathFromCells(cells: readonly string[]): string | null {
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

/** Заголовок секции задачи, откуда разведка сеет `files_to_touch` (`preconditions.ts::TOUCH_SECTION`). */
const TOUCH_HEADING_RE = /Что придётся тронуть/i;
/** Пункт маркированного списка `- …`/`* …` — общая форма, используется и в `handoff.ts::postponedItems`. */
export const BULLET_RE = /^[-*]\s+(.+)$/;

export interface TouchEntry {
  /** Путь как записала разведка, без обратных кавычек. */
  path: string;
  /** Остаток строки после пути — что там менять по мнению разведки. */
  note: string;
}

/**
 * Пути «Что придётся тронуть» задачи — вход `planDiffProblem` (план обязан объяснить
 * каждое расхождение с ними) и будущего засева `files_to_touch` до хода модели (4.1).
 *
 * Строка-образец `‹path/to/file› — ‹что здесь меняем›` (плейсхолдер) законно пуста на
 * форме и пропускается — `hasPlaceholder` тот же предикат, что и у стража заполненности
 * задачи, второй копии словаря плейсхолдера не заводим.
 */
export function touchListEntries(intentText: string): TouchEntry[] {
  const out: TouchEntry[] = [];
  for (const range of h2SectionRanges(intentText, TOUCH_HEADING_RE)) {
    const section = intentText.slice(range.start, range.end);
    for (const raw of section.split('\n')) {
      const m = BULLET_RE.exec(raw.trim());
      if (m === null) continue;
      const rest = m[1]!.trim();
      if (hasPlaceholder(rest)) continue;
      const [pathPart, ...noteParts] = rest.split(/\s+[—–]\s+/);
      const path = clean(pathPart ?? '');
      if (path === '' || !looksLikePath(path)) continue;
      out.push({ path, note: noteParts.join(' — ').trim() });
    }
  }
  return out;
}

/**
 * Начало СЛЕДУЮЩЕГО пункта списка ВЕРХНЕГО УРОВНЯ `- **…` — та же форма, что несут обе
 * метки-соседи («Добавлено сверх разведки», «Из задачи исключено»). Граница региона
 * обязана останавливаться и на этом, не только на следующем заголовке: до этой правки
 * (ревью code-review-all, 2026-09-18, воспроизведено живым прогоном по реальному
 * `plan.template.md`) регион «Добавлено сверх разведки» дотягивался до «Из задачи
 * исключено» ЦЕЛИКОМ — путь, упомянутый в объяснении исключения, засчитывался как уже
 * объяснённое ДОБАВЛЕНИЕ, и наоборот. Строка-продолжение (перенос текста метки на
 * следующую строку с отступом, без нового «- **») этим не задевается: `-\s+\*\*`
 * требует дефиса-маркера списка, отступ один без него не матчит.
 *
 * Якорь — БЕЗ ведущего `\s*`: пункт обязан начинаться с НУЛЕВОГО отступа, а не любого.
 * Вложенный, с отступом, суб-буллет того же вида («  - **Причина:** …» — уточнение к уже
 * названному пути, не соседняя метка) раньше тоже засчитывался за границу и обрубал
 * регион на себе, молча теряя все пути ПОСЛЕ него (ревью code-review-all, 2026-09-19,
 * тоже воспроизведено выполнением кода).
 */
const NEXT_BULLET_RE = /^-\s+\*\*/m;

/**
 * Пути, упомянутые в обратных кавычках между меткой `label` и следующим заголовком, —
 * общий разбор для «Добавлено сверх разведки» и «Из задачи исключено» (4.1): обе метки
 * подряд перечисляют пути с причиной прозой, и вторая копия того же скана не заводится.
 * Пустой список — метки нет (документ не по форме) или после неё путей не названо.
 */
function pathsAfterLabel(planText: string, label: RegExp): string[] {
  const m = label.exec(planText);
  if (m === null) return [];
  const from = m.index + m[0].length;
  const rest = planText.slice(from);
  const headingIdx = NEXT_HEADING_RE.exec(rest)?.index ?? rest.length;
  const bulletIdx = NEXT_BULLET_RE.exec(rest)?.index ?? rest.length;
  const region = rest.slice(0, Math.min(headingIdx, bulletIdx));
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(region)) !== null) {
    const t = clean(mm[1] ?? '');
    if (looksLikePath(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Пути «Из задачи исключено» плана — уже объяснённые изъятия из `files_to_touch`. */
export function excludedFromPlanPaths(planText: string): string[] {
  return pathsAfterLabel(planText, /\*\*Из задачи исключено\*\*/);
}

/** Пути «Добавлено сверх разведки» плана — уже объяснённые добавления сверх карты. */
export function addedBeyondPlanPaths(planText: string): string[] {
  return pathsAfterLabel(planText, /\*\*Добавлено сверх разведки:\*\*/);
}

export function extractFilesToTouch(planText: string): string[] {
  const boundary = filesToTouchSection(planText);
  if (boundary === null) return [];
  const { section } = boundary;

  const lines = section.split('\n');
  // Строка-разделитель отмечает конец шапки таблицы: заголовки («Путь», «Что делаем»)
  // путями не являются, и без этого «Зачем» попадало в allowlist.
  const separatorAt = lines.findIndex((l) => LEADING_PIPE_SEPARATOR_RE.test(l.trim()));

  const out: string[] = [];
  const add = (raw: string | null): void => {
    if (raw === null) return;
    const t = clean(raw);
    if (looksLikePath(t) && !out.includes(t)) out.push(t);
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('|')) {
      if (LEADING_PIPE_SEPARATOR_RE.test(trimmed)) return;
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

/**
 * Засевает пустую таблицу `files_to_touch` строками из «Что придётся тронуть» задачи (4.1,
 * «П»-половина — механический засев ДО хода модели; «М»-половина уже была:
 * `planTouchDiscrepancyProblem` требует объяснить каждое расхождение строкой). Модель
 * получает не пустой список, а список для РЕШЕНИЯ по каждой строке: оставить (дописав
 * содержательное «Что делаем» вместо оставленного здесь плейсхолдера), исключить (стереть
 * строку и назвать путь в «Из задачи исключено» — как и раньше) или добавить свой путь (как
 * и раньше, в «Добавлено сверх разведки»). Семантику стража это не меняет: он по-прежнему
 * сверяет РЕЗУЛЬТАТ, а не то, откуда взялась стартовая строка.
 *
 * Срабатывает РОВНО один раз за жизнь плана: как только `extractFilesToTouch` видит хоть
 * один настоящий путь (свой первый вызов уже его посеял, или модель сама вписала путь
 * раньше рантайма), функция становится no-op. Без этого повторный вход в этап (ретрай,
 * рестарт сервиса) навязывал бы список поверх решения, которое модель уже начала
 * принимать, — тот же приём идемпотентности, что у `autofillClarification`.
 *
 * Заменяются ТОЛЬКО строки таблицы срезу за разделителем `|---|---|` — секция
 * `files_to_touch`, которую возвращает `filesToTouchSection`, включает в себя и соседнюю
 * метку «Добавлено сверх разведки»: замена всего хвоста секции стёрла бы её.
 */
export function seedFilesToTouch(
  planText: string,
  touch: readonly TouchEntry[],
): { text: string; seeded: number } {
  if (touch.length === 0) return { text: planText, seeded: 0 };
  if (extractFilesToTouch(planText).length > 0) return { text: planText, seeded: 0 };

  const boundary = filesToTouchSection(planText);
  if (boundary === null) return { text: planText, seeded: 0 };
  const { start: sectionStart, section } = boundary;

  const lines = section.split('\n');
  const separatorAt = lines.findIndex((l) => LEADING_PIPE_SEPARATOR_RE.test(l.trim()));
  if (separatorAt < 0) return { text: planText, seeded: 0 }; // таблицы нет — не наш формат

  let rowsEnd = separatorAt + 1;
  while (rowsEnd < lines.length && lines[rowsEnd]!.trim().startsWith('|')) rowsEnd++;

  const seen = new Set<string>();
  const rows: string[] = [];
  for (const entry of touch) {
    if (seen.has(entry.path)) continue; // дубли из «Что придётся тронуть» — одна строка
    seen.add(entry.path);
    const what = entry.note === '' ? '‹что делаем›' : entry.note;
    rows.push(`| \`${entry.path}\` | ${what} |`);
  }
  if (rows.length === 0) return { text: planText, seeded: 0 };

  const newLines = [...lines.slice(0, separatorAt + 1), ...rows, ...lines.slice(rowsEnd)];
  const newSection = newLines.join('\n');
  const newText = planText.slice(0, sectionStart) + newSection + planText.slice(sectionStart + section.length);
  return { text: newText, seeded: rows.length };
}
