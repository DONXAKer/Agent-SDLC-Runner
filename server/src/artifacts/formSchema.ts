/**
 * Схема формы, выведенная из текста бланка — шаблона методологии или уже частично
 * заполненного артефакта.
 *
 * Зачем. Модель, заполняющая markdown-бланк руками, ломает не смысл, а форму: оставляет
 * обе ветки меню `A / B`, разворачивает строку-образец таблицы в один пункт, заполняет
 * курсивную легенду как содержимое, теряет `\|` в ячейке, собирает `old_string` без
 * реального переноса строки (44 промаха `Edit` на пять копий, `docs/model-runs.md`). Схема
 * называет каждое незаполненное место ПОЛЕМ с видом, допустимыми значениями и подсказкой,
 * чтобы модель отвечала значением, а разметку рисовал рантайм (`applyFill.ts`).
 *
 * Три правила конструкции:
 *  - вывод идёт по тексту, лежащему на диске, и **не держит копий строк шаблона**: копия
 *    строки методологии в коде разошлась с эталоном при первой же его правке (урок
 *    `prompt/build.ts`). Переопределения (`SCHEMA_OVERRIDES`) — только ключи полей и их
 *    вид/владелец, и тест по реальным шаблонам требует, чтобы каждый ключ нашёлся;
 *  - «незаполненное место» — то же определение, что у стража завершения:
 *    `placeholderRanges` из `artifact.ts`. Схема не заводит второго понятия;
 *  - поле решения человека узнаётся тем же словарём (`isDecisionLine`/`isDecisionCell`) и
 *    модели не отдаётся ни в каком виде — как велит методология.
 *
 * Разбор чистый, без I/O.
 */

import type { StageId } from '@sdlc-runner/shared';

import { headerKey, isSeparatorRow, splitRow } from '../md/table.ts';
import {
  PLACEHOLDER_RE,
  continuationOfDecision,
  isDecisionCell,
  isDecisionLine,
  placeholderRanges,
} from './artifact.ts';
import { CLAIMS_MINIMUM } from './claims.ts';

export type FieldKind =
  | 'scalar'
  | 'multiline'
  | 'choice'
  | 'list'
  | 'records'
  | 'group'
  | 'decision'
  | 'mechanical';

export type FieldOwner = 'model' | 'human' | 'runtime' | 'subagent';

/**
 * Где поле живёт в разметке — от этого зависит, как рантайм рисует значение:
 *  - `label` — строка-метка `- **Метка:** …` (с продолжениями на отступе);
 *  - `heading` — плейсхолдер в заголовке;
 *  - `paragraph` — одиночный `‹…›` строкой под заголовком;
 *  - `bullets` — образцы `- ‹…›` / `- ‹a› — ‹b›`;
 *  - `table` — строка-образец таблицы;
 *  - `cell` — плейсхолдер в фиксированной строке таблицы;
 *  - `yaml` — `ключ: ‹…›` внутри fenced-блока.
 */
export type FieldShape = 'label' | 'heading' | 'paragraph' | 'bullets' | 'table' | 'cell' | 'yaml';

export interface Range {
  start: number;
  end: number;
}

export interface Placeholder extends Range {
  text: string;
}

export interface ChoiceOption {
  /** Ключ, которым модель называет вариант: глиф либо первые слова варианта. */
  key: string;
  /** Текст варианта дословно из бланка (с разметкой) — им и заменяется меню. */
  text: string;
  /** В варианте есть место под комментарий: `❌ — дыры: ‹что именно›`. */
  commentSlot: boolean;
  /** Вариант — сам плейсхолдер: свободный текст вместо выбора. */
  free: boolean;
}

export interface RecordColumn {
  id: string;
  header: string;
  kind: 'scalar' | 'choice' | 'mechanical';
  options?: ChoiceOption[];
}

export interface FormField {
  id: string;
  kind: FieldKind;
  shape: FieldShape;
  /** Ближайший заголовок над полем, нормализованный. */
  section: string;
  label: string | null;
  /** Легенда секции и текст плейсхолдера — подсказка для карточки поля. */
  hint: string;
  owner: FieldOwner;
  /** Поле заполняется только этим этапом: «Что придётся тронуть» интента — разведкой. */
  stageOnly?: StageId;
  options?: ChoiceOption[];
  columns?: RecordColumn[];
  min?: { rows: number; edges?: number };
  /** Строка «по существу пусто» (`н/п — …`), которую бланк держит рядом с образцом. */
  emptyAlternative?: string;
  singleLine?: boolean;
  /** Строки самого поля (метка с продолжениями, образцы) — что заменяется целиком. */
  range: Range;
  /** Куда ложится значение: у меню — вся ветка после метки, у образцов — они сами. */
  valueRange: Range;
  placeholders: Placeholder[];
  /** Текст образца (`bullets`/`table`), по которому рисуются элементы. */
  sample?: string;
  /** Шапка таблицы — для `table`. */
  header?: string;
  /** Строка альтернативы «пусто» в тексте, если она отдельная. */
  altRange?: Range;
}

export interface FormSchema {
  fields: FormField[];
  /** Ключи переопределений, не нашедшие поля: тест по реальным шаблонам требует пустоты. */
  unresolvedOverrides: string[];
}

// ---------------------------------------------------------------------------
// Словари
// ---------------------------------------------------------------------------

const GLYPHS = ['✅', '❌', '⏭', '⚠'] as const;

/**
 * Токены методологии, которыми меню `‹A / B›` внутри плейсхолдера считается перечислением,
 * а не подсказкой: `‹тест / место в коде›` — подсказка (scalar), `‹да/нет›` — выбор.
 * Принятая копия токенов эталона; расхождение ловится тестом по реальным шаблонам.
 */
const MENU_TOKENS: ReadonlySet<string> = new Set([
  'да',
  'нет',
  'н/п',
  'passed',
  'failed',
  'aborted',
  'retry',
  'continue',
  'escalate',
  'blocked_env',
  'true',
  'false',
  'полный',
  'мелкий',
  'совпала',
  'разошлась',
  'та',
  'не та',
  'готова',
  'не готова',
  'шага не было',
  'ещё не проверялась',
  'manual',
]);

/** Строка списка, означающая «по существу пусто» рядом с образцом. */
const EMPTY_ALT_RE = /^(н\/п|нет|ничего|ни одн|границ нет|изменений не было|долг пуст|непокрытых)/iu;

/** Заголовки колонок, которые нумерует рантайм. */
const NUMBERING_HEADERS: ReadonlySet<string> = new Set(['#', '№', 'id', 'k']);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const GROUP_RE = /^#{2,4}\s*Запись\s+(\d+)\s*$/i;

/**
 * Жирная метка поля в двух формах шаблонов: колонка ВНУТРИ жирного («**Метка:**») и
 * колонка ПОСЛЕ жирного, с необязательным курсивным пояснением между ними
 * («**Кто утвердил** _(только имя…)_: н/п»). Та же пара форм, что у `DECISION_LINE` в
 * `artifact.ts` — не копия его регулярки (та привязана к закрытому словарю меток решений),
 * а тот же СПОСОБ найти жирную метку у произвольного поля.
 */
const BOLD_LABEL_RE = /^\*\*\s*([^*:]+?)\s*:?\s*\*\*(?:\s*_[^_]*_)?\s*:?\s*/;

/**
 * Метка и смещение значения в СОДЕРЖИМОМ строки (без ведущего маркера списка). `null` —
 * метки нет: это либо проза без поля, либо образец списка (`- ‹x›`).
 *
 * Единственное определение на рантайм: та же эвристика различает форму «- **Метка:**
 * значение» от «- Метка: значение» и у вывода схемы, и у компактной проекции входов
 * (`sheet.ts`) — расхождение здесь значило бы, что проекция рисует поле иначе, чем его
 * потом ищет схема того же артефакта на следующем этапе.
 */
/**
 * Метка поля — короткая именующая фраза, не предложение. Живой пример спутанности:
 * заполненные примеры эталона несут поясняющие пункты вида «**Шаг состоялся — значит у
 * него есть артефакт.** Развилки вскрыты…» — жирное начало предложения формально
 * совпадает с формой «**Метка:** значение», но точка внутри и обычная длина прозы её
 * выдают. Настоящая метка методологии («Ветка витка», «Кто утвердил», «Сверка с
 * деревом») короче и знаков препинания внутри не несёт.
 */
function looksLikeLabel(label: string): boolean {
  return label.length > 0 && label.length <= 60 && !/[.!?]/.test(label);
}

export function splitLabelLine(content: string): { label: string; valueOffset: number } | null {
  const bold = BOLD_LABEL_RE.exec(content);
  if (bold !== null) {
    const label = (bold[1] ?? '').trim();
    return looksLikeLabel(label) ? { label, valueOffset: bold[0].length } : null;
  }
  // Первое двоеточие ВНЕ плейсхолдера: значение поля сплошь и рядом несёт свои внутренние
  // двоеточия («… совпал с патчем: да / …» — то не про метку), и первого совпадения
  // достаточно, только если оно не спрятано внутри `‹…›` («‹note: x›» не метка).
  const plainColon = mask(content).text.indexOf(':');
  if (plainColon > 0) {
    const label = content.slice(0, plainColon).trim();
    return looksLikeLabel(label) ? { label, valueOffset: plainColon + 1 } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Нормализация имён
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/** Ключ секции: заголовок без нумерации и без пояснения после « — ». */
function sectionKey(heading: string): string {
  const noNum = heading.replace(/^\d+[.)]\s*/, '');
  const noDash = (noNum.split(/\s+[—–]\s+/)[0] ?? noNum).replace(/[«»"]/g, '');
  // Пояснение в скобках («Состояние (машиночитаемое)») — часть заголовка для читателя,
  // не часть ключа секции: без среза «состояние (машиночитаемое)» не совпадало бы с
  // ключом переопределения «состояние», под которым живут поля yaml-блока handoff'а.
  const noParen = noDash.replace(/\s*\(.*$/, '');
  return norm(noParen);
}

/** Ключ метки: «**Ветка витка:**» → «ветка витка»; пояснение в скобках снимается. */
function labelKey(raw: string): string {
  return norm(raw.replace(/\s*[_(].*$/, '').replace(/:\s*$/, ''));
}

/** Ключ из текста плейсхолдера: «‹имя или название — то же на всех витках›» → «имя или название». */
function placeholderKey(inner: string): string {
  const cut = inner.split(/\s+[—–]\s+|[,;:(]/)[0] ?? inner;
  const key = norm(cut);
  return key.length > 48 ? key.slice(0, 48).trim() : key;
}

function isGlyph(s: string): boolean {
  return GLYPHS.some((g) => s.startsWith(g));
}

/** Первые символы варианта меню — его ключ: глиф либо текст до « — ». */
function optionKey(text: string): string {
  const t = text.replace(/\*\*/g, '').replace(/^_+|_+$/g, '').trim();
  const g = GLYPHS.find((x) => t.startsWith(x));
  if (g !== undefined) return g;
  return norm(t.split(/\s+[—–]\s+|\s*\(/)[0] ?? t);
}

// ---------------------------------------------------------------------------
// Плейсхолдеры и меню
// ---------------------------------------------------------------------------

interface Masked {
  text: string;
  inner: string[];
}

const MASK = ' ';

/** Плейсхолдеры заменяются меткой, чтобы « / » и «:» внутри них не резали строку. */
function mask(s: string): Masked {
  const inner: string[] = [];
  const text = s.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (m) => {
    inner.push(m.slice(1, -1));
    return MASK;
  });
  return { text, inner };
}

function unmask(m: Masked, text: string): string {
  let i = 0;
  return text.replace(new RegExp(MASK, 'g'), () => `‹${m.inner[i++] ?? ''}›`);
}

/**
 * Варианты меню внутри ОДНОГО плейсхолдера: `‹✅/❌/⏭›`, `‹да / шага не было›`,
 * `‹✅/❌/н/п — мелкий контур›`. `null` — это подсказка, а не перечисление.
 */
export function menuOptionsOfPlaceholder(inner: string): ChoiceOption[] | null {
  // `н/п` содержит косую черту — защищаем до разбиения.
  const guarded = inner.replace(/н\/п/gi, 'нп');
  const parts = guarded
    .split(/\s*\/\s*/)
    .map((p) => p.replace(//g, '/').trim())
    .filter((p) => p !== '');
  if (parts.length < 2) return null;
  const options: ChoiceOption[] = [];
  for (const part of parts) {
    const key = optionKey(part);
    const known = isGlyph(key) || MENU_TOKENS.has(key);
    if (!known) return null;
    options.push({ key, text: part, commentSlot: /\s[—–]\s/.test(part), free: false });
  }
  return options;
}

/**
 * Варианты меню в ЗНАЧЕНИИ строки-метки: `полный / мелкий — критерий…`,
 * `‹имя› · ‹дата› / **не одобрен…**`, `‹✅ — …› / ‹❌ — …› / ⏭ — гейт в долге`.
 * `null` — меню нет (одна ветка).
 */
function menuOptionsOfValue(value: string): ChoiceOption[] | null {
  const m = mask(value);
  const parts = m.text.split(/\s+\/\s+/);
  if (parts.length < 2) return null;
  let cursor = 0;
  const options: ChoiceOption[] = [];
  for (const part of parts) {
    const count = (part.match(new RegExp(MASK, 'g')) ?? []).length;
    const slice: Masked = { text: part, inner: m.inner.slice(cursor, cursor + count) };
    cursor += count;
    const text = unmask(slice, part).trim();
    const free = /^‹[^›]*›$/.test(text);
    const withPh = count > 0 && !free;
    // Ключ свободного варианта — текст его плейсхолдера: «‹имя›» → «имя».
    const key = free ? placeholderKey(text.slice(1, -1)) : optionKey(unmask(slice, part.replace(new RegExp(MASK, 'g'), '')));
    if (key === '') return null;
    options.push({ key, text, commentSlot: withPh, free });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Вывод схемы
// ---------------------------------------------------------------------------

interface Line {
  raw: string;
  start: number;
  /** Конец строки без перевода. */
  end: number;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const raw of text.split('\n')) {
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    out.push({ raw: body, start, end: start + body.length });
    start += raw.length + 1;
  }
  return out;
}

/** Плейсхолдеры внутри диапазона строки — по общему определению из `artifact.ts`. */
function placeholdersIn(all: readonly Placeholder[], start: number, end: number): Placeholder[] {
  return all.filter((p) => p.start >= start && p.end <= end);
}

/** Строка-продолжение элемента: отступ и не новый маркер списка. */
function isContinuation(raw: string): boolean {
  return /^\s+\S/.test(raw) && !LIST_RE.test(raw) && !raw.trimStart().startsWith('|');
}

interface Builder {
  fields: FormField[];
  ids: Set<string>;
}

function uniqueId(b: Builder, wanted: string, section: string): string {
  let id = wanted === '' ? section : wanted;
  if (!b.ids.has(id)) return id;
  const withSection = `${section}/${id}`;
  if (!b.ids.has(withSection)) return withSection;
  let n = 2;
  while (b.ids.has(`${withSection}/${n}`)) n++;
  return `${withSection}/${n}`;
}

function push(b: Builder, f: FormField): FormField {
  b.ids.add(f.id);
  b.fields.push(f);
  return f;
}

/** Суффикс вида `/2` для подполей: текст между предыдущим плейсхолдером и этим до последнего «:». */
function subLabel(between: string): string | null {
  const m = /([^·;,]*?):\s*$/.exec(between.trim());
  if (m === null) return null;
  const key = labelKey(m[1] ?? '');
  return key === '' ? null : key;
}

/**
 * Поле(я) из строки-метки. Одна строка даёт одно поле, кроме двух случаев: несколько
 * плейсхолдеров → подполя `метка/N` (каждый со своим сплайсом), и меню без плейсхолдера →
 * поле-выбор с `valueRange` на всю ветку.
 */
function labelFields(
  b: Builder,
  line: Line,
  valueStart: number,
  valueEnd: number,
  label: string,
  section: string,
  hint: string,
  shape: FieldShape,
  phs: Placeholder[],
): void {
  const value = line.raw.slice(valueStart - line.start, valueEnd - line.start);
  const key = labelKey(label);
  const base = { section, label: key, hint, owner: 'model' as const, shape };

  const menu = menuOptionsOfValue(value);
  if (menu !== null) {
    push(b, {
      ...base,
      id: uniqueId(b, key, section),
      kind: 'choice',
      options: menu,
      range: { start: line.start, end: valueEnd },
      valueRange: { start: valueStart, end: valueEnd },
      placeholders: phs,
    });
    return;
  }

  if (phs.length === 0) return; // заполненная строка без меню — полем не является

  if (phs.length === 1) {
    const ph = phs[0]!;
    const inner = menuOptionsOfPlaceholder(ph.text.slice(1, -1));
    push(b, {
      ...base,
      id: uniqueId(b, key, section),
      kind: inner === null ? 'scalar' : 'choice',
      ...(inner === null ? {} : { options: inner }),
      range: { start: line.start, end: valueEnd },
      valueRange: { start: ph.start, end: ph.end },
      placeholders: [ph],
    });
    return;
  }

  // Несколько плейсхолдеров в одной строке-метке: «‹✅/❌/⏭› · ветка: ‹та / не та›; …».
  // Подметка первого — само имя поля («N/1»); у остальных — текст перед ними до
  // последнего «:» («что изменилось: ‹…›» → «что изменилось»), а без него — порядковый
  // номер. `wanted` строится РОВНО один раз из ключа и найденной подметки — раньше
  // найденная подметка сама уже несла префикс поля (`subLabel` возвращал «вход/2» в
  // обход `??`), и сборка id приклеивала ключ ВТОРОЙ раз («вход/вход/2»).
  let prevEnd = valueStart;
  for (const [idx, ph] of phs.entries()) {
    const between = line.raw.slice(prevEnd - line.start, ph.start - line.start);
    const detected = idx === 0 ? null : subLabel(between);
    const subKey = detected ?? String(idx + 1);
    const inner = menuOptionsOfPlaceholder(ph.text.slice(1, -1));
    const wanted = idx === 0 ? `${key}/1` : `${key}/${subKey}`;
    push(b, {
      ...base,
      label: idx === 0 ? key : subKey,
      id: uniqueId(b, wanted, section),
      kind: inner === null ? 'scalar' : 'choice',
      ...(inner === null ? {} : { options: inner }),
      range: { start: line.start, end: valueEnd },
      valueRange: { start: ph.start, end: ph.end },
      placeholders: [ph],
    });
    prevEnd = ph.end;
  }
}

/** Ключ строки таблицы для полей фиксированных ячеек: номер либо первые слова первой ячейки. */
function rowKey(first: string): string {
  const k = norm(first).replace(/[«»"]/g, '');
  return k.length > 30 ? k.slice(0, 30).trim() : k;
}

function columnsOf(header: readonly string[], sample: readonly string[]): RecordColumn[] {
  return header.map((h, i) => {
    const id = headerKey(h);
    const cell = (sample[i] ?? '').trim();
    const bare = cell.replace(/`/g, '');
    if (NUMBERING_HEADERS.has(id) || /^claim-\d+$/i.test(bare) || /^\d+$/.test(bare)) {
      return { id, header: h, kind: 'mechanical' as const };
    }
    const phInner = /^‹([^›]*)›$/.exec(bare)?.[1];
    const options =
      phInner === undefined ? menuOptionsOfValue(bare) : menuOptionsOfPlaceholder(phInner);
    if (options !== null) return { id, header: h, kind: 'choice' as const, options };
    return { id, header: h, kind: 'scalar' as const };
  });
}

/** Строка таблицы — образец: все ячейки, кроме ведущей нумерации/id, шаблонные. */
function isSampleRow(cells: readonly string[]): boolean {
  if (!cells.some((c) => c.includes('‹'))) return false;
  return cells.every((c, i) => {
    const t = c.replace(/`/g, '').trim();
    if (t === '') return true;
    if (i === 0 && (/^\d+$/.test(t) || /^claim-\d+$/i.test(t))) return true;
    if (t.includes('‹')) return true;
    return menuOptionsOfValue(t) !== null;
  });
}

export function deriveSchema(text: string, templateName?: string): FormSchema {
  const b: Builder = { fields: [], ids: new Set() };
  const all = placeholderRanges(text);
  const lines = splitLines(text);

  let section = '';
  let sectionHints: string[] = [];
  let inFence = false;
  let inItalic = false;
  let group: string | null = null;

  // Состояние таблицы.
  let header: string[] | null = null;
  let headerLine: Line | null = null;
  let tableField: FormField | null = null;
  let tableIndex = 0;

  // Состояние списка образцов.
  let listField: FormField | null = null;
  /** Тексты всех образцов текущего списка — подсказка поля копит их, а не только последний. */
  let listExtras: string[] = [];

  const closeTable = (): void => {
    header = null;
    headerLine = null;
    tableField = null;
  };
  const closeList = (): void => {
    listField = null;
    listExtras = [];
  };
  const hintOf = (extra?: string): string => {
    const parts = [...sectionHints];
    if (extra !== undefined && extra !== '') parts.push(extra);
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    return Buffer.byteLength(joined, 'utf8') > 800 ? `${joined.slice(0, 400)}…` : joined;
  };
  const sec = (): string => (group === null ? section : group);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const raw = line.raw;
    const trimmed = raw.trim();

    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      closeTable();
      closeList();
      continue;
    }

    if (inFence) {
      const m = /^(\s*)([\w.-]+):\s*(.*)$/.exec(raw);
      if (m === null) continue;
      const phs = placeholdersIn(all, line.start, line.end);
      if (phs.length === 0) continue;
      const ph = phs[0]!;
      const inner = menuOptionsOfPlaceholder(ph.text.slice(1, -1));
      push(b, {
        id: uniqueId(b, `${sec()}/${m[2]!.toLowerCase()}`, sec()),
        kind: inner === null ? 'scalar' : 'choice',
        shape: 'yaml',
        section: sec(),
        label: m[2]!,
        hint: hintOf(ph.text.slice(1, -1)),
        owner: 'model',
        ...(inner === null ? {} : { options: inner }),
        singleLine: true,
        range: { start: line.start, end: line.end },
        valueRange: { start: ph.start, end: ph.end },
        placeholders: [ph],
      });
      continue;
    }

    if (trimmed.startsWith('>')) continue;

    const h = HEADING_RE.exec(trimmed);
    if (h !== null) {
      closeTable();
      closeList();
      inItalic = false;
      const g = GROUP_RE.exec(trimmed);
      if (g !== null) {
        group = `запись ${g[1]!}`;
        push(b, {
          id: uniqueId(b, group, group),
          kind: 'group',
          shape: 'heading',
          section: group,
          label: group,
          hint: hintOf(),
          owner: 'model',
          range: { start: line.start, end: line.end },
          valueRange: { start: line.end, end: line.end },
          placeholders: [],
        });
        continue;
      }
      group = null;
      section = sectionKey(h[2]!);
      sectionHints = [];
      const phs = placeholdersIn(all, line.start, line.end);
      for (const ph of phs) {
        push(b, {
          id: uniqueId(b, placeholderKey(ph.text.slice(1, -1)), section),
          kind: 'scalar',
          shape: 'heading',
          section,
          label: null,
          hint: ph.text.slice(1, -1),
          owner: 'model',
          singleLine: true,
          range: { start: line.start, end: line.end },
          valueRange: { start: ph.start, end: ph.end },
          placeholders: [ph],
        });
      }
      continue;
    }

    // Таблица.
    if (trimmed.startsWith('|')) {
      closeList();
      inItalic = false;
      if (header === null) {
        header = splitRow(trimmed);
        headerLine = line;
        continue;
      }
      if (isSeparatorRow(trimmed)) continue;
      const cells = splitRow(trimmed);
      const phs = placeholdersIn(all, line.start, line.end);

      // Колонка подписи человека в шапке — вся строка решение, модели не отдаётся.
      if (header.some(isDecisionCell)) {
        if (phs.length > 0) {
          push(b, {
            id: uniqueId(b, `${sec()}/решение`, sec()),
            kind: 'decision',
            shape: 'table',
            section: sec(),
            label: null,
            hint: hintOf(),
            owner: 'human',
            range: { start: line.start, end: line.end },
            valueRange: { start: line.start, end: line.end },
            placeholders: phs,
            header: headerLine?.raw.trim() ?? '',
          });
        }
        continue;
      }

      if (isSampleRow(cells)) {
        if (tableField === null) {
          tableIndex += 1;
          const columns = columnsOf(header, cells);
          const claimTable = /^claim-\d+$/i.test((cells[0] ?? '').replace(/`/g, '').trim());
          tableField = push(b, {
            id: uniqueId(b, sec(), sec()),
            kind: 'records',
            shape: 'table',
            section: sec(),
            label: null,
            hint: hintOf(cells.filter((c) => c.includes('‹')).join(' · ')),
            owner: 'model',
            columns,
            ...(claimTable ? { min: { rows: CLAIMS_MINIMUM.rows, edges: CLAIMS_MINIMUM.edges } } : {}),
            range: { start: line.start, end: line.end },
            valueRange: { start: line.start, end: line.end },
            placeholders: phs,
            sample: trimmed,
            header: headerLine?.raw.trim() ?? '',
          });
        } else {
          tableField.range.end = line.end;
          tableField.valueRange.end = line.end;
          tableField.placeholders.push(...phs);
        }
        continue;
      }

      if (phs.length === 0) {
        // Строка без плейсхолдеров сразу за образцом — альтернатива «пусто».
        if (tableField !== null && tableField.altRange === undefined && EMPTY_ALT_RE.test((cells[0] ?? '').trim())) {
          tableField.emptyAlternative = trimmed;
          tableField.altRange = { start: line.start, end: line.end };
        }
        continue;
      }

      // Фиксированная строка: поле на каждую ячейку с плейсхолдером.
      const first = rowKey(cells[0] ?? '');
      let offset = line.start;
      for (const [ci, cell] of cells.entries()) {
        const at = raw.indexOf(cell, offset - line.start);
        const cellStart = at < 0 ? offset : line.start + at;
        const cellEnd = cellStart + cell.length;
        offset = cellEnd;
        const cellPhs = phs.filter((p) => p.start >= cellStart && p.end <= cellEnd);
        for (const ph of cellPhs) {
          const inner = menuOptionsOfPlaceholder(ph.text.slice(1, -1));
          const col = headerKey(header[ci] ?? String(ci));
          push(b, {
            id: uniqueId(b, `${sec()}/${first}/${col}`, sec()),
            kind: inner === null ? 'scalar' : 'choice',
            shape: 'cell',
            section: sec(),
            label: col,
            hint: hintOf(ph.text.slice(1, -1)),
            owner: 'model',
            ...(inner === null ? {} : { options: inner }),
            singleLine: true,
            range: { start: line.start, end: line.end },
            valueRange: { start: ph.start, end: ph.end },
            placeholders: [ph],
          });
        }
      }
      continue;
    }
    closeTable();

    if (trimmed === '') {
      // Пустая строка закрывает список образцов, но не многострочную легенду.
      if (!inItalic) closeList();
      continue;
    }

    const phs = placeholdersIn(all, line.start, line.end);

    // Курсивная легенда: подсказка, не поле — кроме легенды с плейсхолдером.
    const italicStart = trimmed.startsWith('_') || trimmed.startsWith('*_');
    if ((inItalic || italicStart) && phs.length === 0) {
      sectionHints.push(trimmed.replace(/^\*?_+|_+\*?$/g, ''));
      inItalic = !/_\)?\*?$/.test(trimmed) || (!inItalic && italicStart && !/_\)?\*?$/.test(trimmed));
      if (italicStart && /_\)?\*?$/.test(trimmed) && trimmed.length > 1) inItalic = false;
      continue;
    }
    inItalic = false;

    // Решение человека — не поле модели.
    if (isDecisionLine(raw)) {
      closeList();
      const label = /\*\*\s*([^*:]+?)\s*(?::\s*\*\*|\*\*)/.exec(raw)?.[1] ?? 'решение';
      push(b, {
        id: uniqueId(b, labelKey(label), sec()),
        kind: 'decision',
        shape: 'label',
        section: sec(),
        label: labelKey(label),
        hint: hintOf(),
        owner: 'human',
        range: { start: line.start, end: line.end },
        valueRange: { start: line.end, end: line.end },
        placeholders: phs,
      });
      continue;
    }
    if (/^\s+\S/.test(raw) && continuationOfDecision(text, line.start)) continue;

    const list = LIST_RE.exec(raw);
    const content = list === null ? trimmed : list[3]!;
    const contentStart = list === null ? line.start + raw.indexOf(trimmed) : line.start + raw.length - content.length;

    // Продолжения элемента списка (отступ) — часть его значения.
    let valueEndLine = line;
    let j = i + 1;
    while (j < lines.length && isContinuation(lines[j]!.raw) && !/^\s*_/.test(lines[j]!.raw)) {
      valueEndLine = lines[j]!;
      j++;
    }
    const fullPhs = placeholdersIn(all, line.start, valueEndLine.end);

    const split = splitLabelLine(content);
    const labelRaw = split === null ? null : split.label;
    const valueOffset = split === null ? 0 : split.valueOffset;
    const labelLike =
      labelRaw !== null &&
      !/^\[ \]/.test(labelRaw) &&
      (list !== null || BOLD_LABEL_RE.test(content) || fullPhs.length > 0);

    if (labelLike && labelRaw !== null) {
      closeList();
      // Значение начинается сразу после метки; продолжения строк — тоже значение.
      const valueStartOffset = content.slice(valueOffset).search(/\S/);
      const valueStart = contentStart + valueOffset + Math.max(0, valueStartOffset);
      const valueEnd = valueEndLine.end;
      const wholeLine: Line = { raw: text.slice(line.start, valueEnd), start: line.start, end: valueEnd };
      labelFields(b, wholeLine, valueStart, valueEnd, labelRaw, sec(), hintOf(), 'label', fullPhs);
      i = j - 1;
      continue;
    }

    if (fullPhs.length === 0) {
      // Пункт без плейсхолдера сразу за образцами — альтернатива «пусто».
      if (list !== null && listField !== null && listField.altRange === undefined && EMPTY_ALT_RE.test(content)) {
        listField.emptyAlternative = content;
        listField.altRange = { start: line.start, end: valueEndLine.end };
      } else {
        closeList();
      }
      i = j - 1;
      continue;
    }

    // Одиночный плейсхолдер строкой — абзац секции.
    if (list === null && /^‹[^›]*›$/.test(trimmed)) {
      closeList();
      const ph = fullPhs[0]!;
      push(b, {
        id: uniqueId(b, sec(), sec()),
        kind: 'multiline',
        shape: 'paragraph',
        section: sec(),
        label: null,
        hint: hintOf(ph.text.slice(1, -1)),
        owner: 'model',
        range: { start: line.start, end: valueEndLine.end },
        valueRange: { start: ph.start, end: ph.end },
        placeholders: fullPhs,
      });
      i = j - 1;
      continue;
    }

    if (list === null) {
      // Проза с плейсхолдерами без метки: поле на каждый плейсхолдер, ключ — его текст.
      for (const ph of fullPhs) {
        push(b, {
          id: uniqueId(b, placeholderKey(ph.text.slice(1, -1)), sec()),
          kind: 'scalar',
          shape: 'label',
          section: sec(),
          label: null,
          hint: hintOf(ph.text.slice(1, -1)),
          owner: 'model',
          range: { start: line.start, end: valueEndLine.end },
          valueRange: { start: ph.start, end: ph.end },
          placeholders: [ph],
        });
      }
      i = j - 1;
      continue;
    }

    // Образец элемента списка: `- ‹x›`, `- ‹a› — ‹b›`, `- [ ] **[блокирующий]** ‹вопрос›`.
    const sampleText = text.slice(line.start, valueEndLine.end);
    const inlineAlt = (() => {
      const parts = mask(content).text.split(/\s+\/\s+/);
      if (parts.length < 2) return null;
      const alt = parts.find((p) => !p.includes(MASK) && EMPTY_ALT_RE.test(p.trim()));
      return alt === undefined ? null : alt.trim();
    })();
    if (listField !== null) {
      // Второй образец того же списка: расширяем поле, а не заводим новое.
      listField.range.end = valueEndLine.end;
      listField.valueRange.end = valueEndLine.end;
      listField.placeholders.push(...fullPhs);
      listExtras.push(content);
      listField.hint = hintOf(listExtras.join(' '));
      i = j - 1;
      continue;
    }
    const kind: FieldKind = fullPhs.length >= 2 ? 'records' : 'list';
    const columns =
      kind === 'records'
        ? fullPhs.map((ph) => {
            const inner = ph.text.slice(1, -1);
            const options = menuOptionsOfPlaceholder(inner);
            return options === null
              ? { id: placeholderKey(inner), header: inner, kind: 'scalar' as const }
              : { id: placeholderKey(inner), header: inner, kind: 'choice' as const, options };
          })
        : undefined;
    listExtras = [content];
    listField = push(b, {
      id: uniqueId(b, sec(), sec()),
      kind,
      shape: 'bullets',
      section: sec(),
      label: null,
      hint: hintOf(content),
      owner: 'model',
      ...(columns === undefined ? {} : { columns }),
      ...(inlineAlt === null ? {} : { emptyAlternative: inlineAlt }),
      range: { start: line.start, end: valueEndLine.end },
      valueRange: { start: line.start, end: valueEndLine.end },
      placeholders: fullPhs,
      sample: sampleText,
    });
    i = j - 1;
  }

  const unresolved = applyOverrides(b.fields, templateName);
  return { fields: b.fields, unresolvedOverrides: unresolved };
}

// ---------------------------------------------------------------------------
// Переопределения — ключи и вид, никаких копий текста шаблона
// ---------------------------------------------------------------------------

interface Override {
  kind?: FieldKind;
  owner?: FieldOwner;
  stageOnly?: StageId;
}

/**
 * Что вывод по тексту знать не может: чьё поле (рантайм знает `base_sha` и даты, разведка
 * заполняет секцию интента, вердикт считает `passed`) и где заполнение принадлежит
 * другому этапу. Ключи — id полей, как их выводит `deriveSchema`; отсутствующий ключ
 * попадает в `unresolvedOverrides`, и тест по реальным шаблонам эталона требует пустоты.
 */
export const SCHEMA_OVERRIDES: Readonly<Record<string, Readonly<Record<string, Override>>>> = {
  'intent.template.md': {
    'что придётся тронуть': { stageOnly: 'explore' },
  },
  'plan.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'вход/1': { owner: 'runtime', kind: 'mechanical' },
    'вход/2': { owner: 'runtime', kind: 'mechanical' },
    'база': { owner: 'runtime', kind: 'mechanical' },
  },
  'exploration-report.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'приёмочный лист, выведенный независимо': { owner: 'subagent' },
  },
  'clarification-report.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'разведка': { owner: 'runtime', kind: 'mechanical' },
  },
  'chunk-journal.template.md': {
    'n': { owner: 'runtime', kind: 'mechanical' },
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'план': { owner: 'runtime', kind: 'mechanical' },
    'база': { owner: 'runtime', kind: 'mechanical' },
    'бюджет попыток': { owner: 'runtime', kind: 'mechanical' },
    'попытки/1/дата': { owner: 'runtime', kind: 'mechanical' },
    'попытки/1/итог': { owner: 'runtime', kind: 'mechanical' },
  },
  'verification-report.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'n': { owner: 'runtime', kind: 'mechanical' },
    'k': { owner: 'runtime', kind: 'mechanical' },
    'diff/1': { owner: 'runtime', kind: 'mechanical' },
    'diff/2': { owner: 'runtime', kind: 'mechanical' },
    'сверка с деревом': { owner: 'runtime', kind: 'mechanical' },
    'passed': { owner: 'runtime', kind: 'mechanical' },
    'action': { owner: 'runtime', kind: 'mechanical' },
    'попытка/1': { owner: 'runtime', kind: 'mechanical' },
    'попытка/2': { owner: 'runtime', kind: 'mechanical' },
  },
  'handoff.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'состояние/slug': { owner: 'runtime', kind: 'mechanical' },
    'состояние/repo': { owner: 'runtime', kind: 'mechanical' },
    'состояние/branch': { owner: 'runtime', kind: 'mechanical' },
    'состояние/base_sha': { owner: 'runtime', kind: 'mechanical' },
    'состояние/gates_date': { owner: 'runtime', kind: 'mechanical' },
    'состояние/chunk': { owner: 'runtime', kind: 'mechanical' },
    'состояние/attempts': { owner: 'runtime', kind: 'mechanical' },
    'состояние/verdict': { owner: 'runtime', kind: 'mechanical' },
  },
  'readiness.template.md': {
    'название витка': { owner: 'runtime', kind: 'mechanical' },
    'дата': { owner: 'runtime', kind: 'mechanical' },
    'прогон 2/дата': { owner: 'runtime', kind: 'mechanical' },
  },
};

function applyOverrides(fields: FormField[], templateName: string | undefined): string[] {
  if (templateName === undefined) return [];
  const table = SCHEMA_OVERRIDES[templateName];
  if (table === undefined) return [];
  // Сравнение НОРМАЛИЗОВАННОЕ: ключи переопределений пишутся по-русски дословно («что
  // придётся тронуть»), а `norm()`, которым выведен `id`, заменяет `ё→е`. Точное сравнение
  // молча теряло каждый ключ с «ё» — тест по реальным шаблонам это и поймал.
  const byNorm = new Map(fields.map((f) => [norm(f.id), f] as const));
  const unresolved: string[] = [];
  for (const [id, o] of Object.entries(table)) {
    const f = byNorm.get(norm(id));
    if (f === undefined) {
      unresolved.push(id);
      continue;
    }
    if (o.kind !== undefined) f.kind = o.kind;
    if (o.owner !== undefined) f.owner = o.owner;
    if (o.stageOnly !== undefined) f.stageOnly = o.stageOnly;
  }
  return unresolved;
}

/** Поля, которые заполняет модель на этом этапе: не решения, не механика, не чужой этап. */
export function modelFields(schema: FormSchema, stage?: StageId): FormField[] {
  return schema.fields.filter(
    (f) =>
      f.owner === 'model' &&
      f.kind !== 'decision' &&
      f.kind !== 'mechanical' &&
      f.kind !== 'group' &&
      // Безопасное умолчание: вызывающий, не назвавший этап, получает поля БЕЗ метки
      // `stageOnly` — не наоборот. Обратное («не знаю этап — верните всё») отдало бы
      // «Что придётся тронуть» интента формФиллу этапа 1, хотя это работа разведки.
      (f.stageOnly === undefined || f.stageOnly === stage),
  );
}

/** Поле по id — точное совпадение либо нормализованное (регистр, `ё`, пробелы). */
export function findField(schema: FormSchema, id: string): FormField | undefined {
  const exact = schema.fields.find((f) => f.id === id);
  if (exact !== undefined) return exact;
  const want = norm(id);
  return schema.fields.find((f) => norm(f.id) === want);
}
