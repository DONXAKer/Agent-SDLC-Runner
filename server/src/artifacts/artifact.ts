/**
 * Чтение и правка артефактов витка.
 *
 * Два правила методологии, которые здесь материализованы:
 *
 * 1. «Остался хоть один `‹…›` — артефакт не готов». Плейсхолдеры считаются, а не
 *    оцениваются на глаз, и не бывает «почти заполнен».
 * 2. «Одобрение, оставшееся в чате, для следующей сессии не существует». Решение
 *    человека — поле в файле с именем и датой; предусловия следующего этапа проверяют
 *    файл, а не память диалога.
 *
 * Чтение решения — fail-closed. Формы держат оба исхода в одной строке («‹имя› · ‹дата› /
 * **не одобрен**»), человек вычёркивает лишний, и способов вычеркнуть много. Всё, что не
 * является внятной подписью с именем и датой, одобрением не считается: пропустить
 * «отклонён» как согласие дороже, чем лишний раз попросить человека дописать дату.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Плейсхолдер формы методологии: «‹что сюда вписать›».
 *
 * Только типографские скобки. ASCII-вариант `<…>` пробовался — чтобы ловить формы,
 * которые редактор без типографских кавычек переписал в `<…>`, — и оказался хуже болезни:
 * артефакты витка полны обычного текста в угловых скобках (`Map<string, Gate>`, `<br>`,
 * `if (a < b)`), и каждый такой фрагмент становился «незаполненным местом». Отчёт этапа 6,
 * где рецензент привёл сигнатуру дженерика, переставал считаться готовым, а счётчик
 * плейсхолдеров в интерфейсе показывал десятки несуществующих дыр. Ложная тревога здесь
 * дороже пропуска: пропущенный плейсхолдер ловится следующим же читателем формы, а
 * ложный блокирует этап намертво. Одно понятие — одно определение, отсюда экспорт.
 *
 * Один уровень ВЛОЖЕННОСТИ разбирается сознательно. Подсказка внутри плейсхолдера сама
 * ссылается на плейсхолдер — в шаблоне отчёта разведки эталона это «‹✅/❌ — греп `‹…›` по
 * артефактам…›», — и простое `‹[^›]*›` обрывалось на первом `›`, оставляя в тексте хвост
 * «` по артефактам…›». Своим хвостом строка оставалась незаполненной, ЧТО БЫ модель в неё
 * ни записала: замер 2026-09-04 (`polza:ministral-14b`, 14 семейств) показал два витка,
 * вставших на `explore` с невычерпываемым остатком мест — 26 → 18 → 9 → 6 → 6 → 6, и
 * анти-цикл гасил этап. Глубже одного уровня формы методологии не идут, и рекурсию сюда
 * заводить незачем: альтернатива без общего первого символа не порождает перебора.
 */
export const PLACEHOLDER_RE = /‹(?:[^‹›]|‹[^›]*›)*›/g;

/** Есть ли в значении незаполненное место. Для одной ячейки, а не для файла целиком. */
export function hasPlaceholder(value: string): boolean {
  return new RegExp(PLACEHOLDER_RE.source).test(value);
}

/** Подпись человека: имя и дата в любом внятном написании. */
const HAS_DATE = /\d{4}-\d{2}-\d{2}|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/;
/**
 * Имя — либо слово от двух букв, либо инициалы («А. Г.», «A.G.»).
 *
 * Инициалы — обычная форма подписи в русском документообороте, и требование слова от двух
 * букв отвергало их: подпись «А. Г. · 2026-08-16» читалась как «нет имени утвердившего» и
 * роняла одобренный план на предусловии следующего этапа.
 */
const HAS_NAME = /\p{L}{2,}|\p{L}\s*\.\s*\p{L}\s*\./u;

/**
 * Единственный предикат «это подпись живого человека» на весь рантайм.
 *
 * До этого копий было три, с разной планкой, и самая слабая (без даты) стояла ровно на
 * пути, который делает красный вердикт зелёным — снятии `⏭` строкой неприменимости, —
 * а самая строгая на путях, которые вердикт роняют. Один и тот же человек, подписавший
 * одинаково, получал разные исходы.
 */
export function signatureProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'поле не заполнено';
  if (hasPlaceholder(v)) return 'в поле осталась форма, а не подпись';
  if (!HAS_NAME.test(v)) return 'нет имени утвердившего';
  if (!HAS_DATE.test(v)) return 'нет даты';
  return null;
}

export function isSignedByHuman(value: string): boolean {
  return signatureProblem(value) === null;
}

/**
 * Ослабленный вариант: только имя, без даты.
 *
 * Ровно для колонки «Утвердил (человек)» в таблице неприменимости — форма методологии
 * держит там `‹имя›` и говорит дословно: «колонка "Утвердил" без имени = артефакт не
 * заполнен». Требовать дату там, где форма её не просит, значило добавить методологии
 * условие от себя: строка неприменимости, заполненная строго по шаблону, не снимала `⏭`,
 * и обязательный гейт ронял вердикт при полностью правильном артефакте.
 *
 * Отдельная функция, а не параметр, чтобы места вызова были пересчитываемы: планка «без
 * даты» законна в одном месте на весь рантайм.
 */
export function nameOnlyProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'поле не заполнено';
  if (hasPlaceholder(v)) return 'в поле осталась форма, а не имя';
  if (!HAS_NAME.test(v)) return 'нет имени утвердившего';
  return null;
}

export interface ArtifactState {
  path: string;
  exists: boolean;
  text: string;
  /** Сколько незаполненных мест осталось. Ноль — необходимое, но не достаточное условие. */
  placeholders: number;
}

export function readArtifact(path: string): ArtifactState {
  if (!existsSync(path)) return { path, exists: false, text: '', placeholders: 0 };
  const text = readFileSync(path, 'utf8');
  return { path, exists: true, text, placeholders: countPlaceholders(text) };
}

/**
 * Дешёвая проверка существования: предусловия этапов спрашивают «файл на месте?» по
 * каждому входу на каждый запрос состояния, и чтение содержимого ради булева ответа
 * стоило 400 КБ с диска на один GET — патч попытки читался целиком и прогонялся
 * регуляркой, чтобы вернуть true.
 */
export function artifactExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Существование пути ЛЮБОГО вида — и файла, и каталога.
 *
 * Отдельно от `artifactExists` намеренно: артефакт витка обязан быть файлом, а вот
 * карта кодовой базы отчёта разведки законно называет каталоги («server/src/exec/ —
 * исполнители этапов»), и проверка `isFile()` объявляла честный отчёт сочинённым.
 */
export function pathExistsAny(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function writeArtifact(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Строка, начинающаяся с `>` (после пробелов) — markdown-цитата. Шапка каждого шаблона
 * методологии оформлена такой цитатой и дословно объясняет конвенцию плейсхолдеров
 * («Незаполненные места помечены `‹…›`») — этот пример сам по себе является валидной
 * парой `‹…›` и раньше засчитывался как незаполненное поле в полностью готовом
 * документе, блокируя старт этапа на собственной документации формы.
 */
function isBlockquoteLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let i = lineStart;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text[i] === '>';
}

/**
 * Позиции, закрытые ОДНОСТРОЧНЫМ кодом. Тройные ограждения сюда НЕ входят.
 *
 * Плейсхолдер в инлайн-коде — упоминание символа: ячейка набора, сама объясняющая
 * сканирование плейсхолдеров (`grep -c '‹'`), давала ложный провал на шести витках из
 * шести. Скан, не отличающий упоминание от незаполненного места, приучает игнорировать себя.
 *
 * А вот блок в тройных кавычках гасить нельзя, и это проверено числами: формы методологии
 * держат в таких блоках НАСТОЯЩИЕ поля — вся машиночитаемая шапка `handoff.template.md`
 * (`slug`, `branch`, `base_sha`, `commit`, `verdict`, `published` — десять полей) лежит в
 * ```-блоке. Пока они гасились, документ с пустой шапкой показывал «незаполненных мест: 0».
 */
function codeRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];

  // Инлайн-код: только в пределах строки — незакрытая кавычка не должна проглатывать
  // остаток документа вместе с настоящими незаполненными полями.
  const inline = /`[^`\n]+`/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });

  return out;
}

export function countPlaceholders(text: string): number {
  return placeholderRanges(text).length;
}

/**
 * Диапазон markdown-секции `## heading` — от заголовка до следующего заголовка того же
 * уровня или конца текста. `null`, если секции нет.
 */
function sectionRange(text: string, heading: string): { start: number; end: number } | null {
  const escaped = escapeRe(heading);
  const start = new RegExp(`^##\\s+${escaped}\\s*$`, 'm').exec(text);
  if (start === null) return null;
  const bodyStart = start.index + start[0].length;
  const next = /^##\s+/m.exec(text.slice(bodyStart));
  return { start: start.index, end: next === null ? text.length : bodyStart + next.index };
}

/**
 * Плейсхолдеры вне названных секций верхнего уровня (`## …`).
 *
 * Ровно один случай методологии требует этого исключения: секция «Что придётся тронуть»
 * интента заполняется агентом разведки на этапе 2 — шаблон объявляет это дословно тремя
 * абзацами ниже собственной шапки «остался `‹…›` — не готово». Пока предусловие этапа 2
 * считало и её, разведка не запускалась НИКОГДА при живом первом проходе (обнаружено
 * контрольным прогоном бенчмарка на живой модели, до этого сквозной виток не гонялся ни
 * разу). Исключение узкое и применяется только к предусловию входа в разведку — к плану,
 * которому эта секция уже обязана быть заполнена разведкой, применяется обычный
 * `countPlaceholders`.
 */
export function countPlaceholdersExceptSections(text: string, headings: readonly string[]): number {
  const excluded = headings
    .map((h) => sectionRange(text, h))
    .filter((r): r is { start: number; end: number } => r !== null);
  return placeholderRanges(text).filter((p) => !excluded.some((r) => p.start >= r.start && p.start < r.end)).length;
}

/** Позиции незаполненных мест — для подсветки в редакторе артефакта. */
export function placeholderRanges(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  const code = codeRanges(text);
  const inCode = (i: number): boolean => code.some((r) => i >= r.start && i < r.end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!isBlockquoteLine(text, m.index) && !inCode(m.index)) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Поля решений человека
// ---------------------------------------------------------------------------

/**
 * Метки полей — дословно из форм методологии. Сверка идёт по ним, поэтому менять их
 * можно только вместе с шаблонами в эталоне.
 */
export const DECISION = {
  /** plan.md — этап 4, одобрение плана. */
  approval: 'Одобрение',
  /** chunk-N-journal.md — этап 5, подтверждение места правки. */
  confirmed: 'Подтвердил',
  /** handoff.md — этап 7, приёмка вердикта. */
  accepted: 'Приёмка',
  /** exploration-report.md — этап 2, решение о полноте приёмочного листа. */
  checklistComplete: 'Решение человека о полноте',
  /** handoff.md — запись о дефекте, кто утвердил классификацию. */
  whoApproved: 'Кто утвердил',
} as const;

export type DecisionLabel = (typeof DECISION)[keyof typeof DECISION];

/**
 * Строка, несущая ПОЛЕ решения человека, — НЕ поле машины ни в одном автозаполнителе.
 *
 * Матчится жирная метка поля (`**Подтвердил:**`, `- **Одобрение:** …`) — так поля решений
 * и записаны во всех формах методологии (`fieldRegex` ниже читает их той же формой). Голая
 * подстрока не годится в обе стороны: «приёмка не запускалась» в легендах handoff-бланка —
 * проза с машинными плейсхолдерами, и подстрочный матч отнимал их у автозаполнения
 * (ревью-2, пойман прогоном шаблона); а «подтвердила» в содержательном тексте гасила бы
 * поле молча. Единственный источник меток — значения `DECISION`.
 */
const DECISION_LABELS = Object.values(DECISION);

// Две формы записи поля: двоеточие ВНУТРИ жирного («**Подтвердил:** ‹имя›») и двоеточие
// ПОСЛЕ жирной метки с пояснением («**Кто утвердил** _(только имя…)_: н/п / ‹имя›» —
// форма handoff-бланка, потерянная первой версией и пойманная ревью-3). Инфикс после
// метки («**Одобрение плана:**») допускается сознательно: направление ошибки fail-closed
// (поле остаётся человеку), а строгий `fieldRegex` для записи решений — отдельная планка.
const DECISION_LINE = new RegExp(
  `\\*\\*\\s*(${DECISION_LABELS.map(escapeRe).join('|')})([^*]*:\\s*\\*\\*|\\s*\\*\\*[^\\n]{0,120}?:)`,
  'i',
);

export function isDecisionLine(line: string): boolean {
  return DECISION_LINE.test(line);
}

/**
 * Какие поля решений человека вообще присутствуют в тексте артефакта.
 *
 * Нужно тому, кто сравнивает документ ДО и ПОСЛЕ записи: исчезнувшая метка — потеря поля,
 * принадлежащего человеку, чем бы ни объяснялась. Считается тем же `DECISION_LINE`, что и
 * `isDecisionLine`: вторая рукописная форма метки разошлась бы с первой на первом же
 * уроке шаблона (ровно так и случилось с формой handoff-бланка, ревью-3).
 */
export function decisionLabelsIn(text: string): DecisionLabel[] {
  const lines = text.split('\n');
  return DECISION_LABELS.filter((label) => {
    // Метка ищется по всему набору, но подтверждается ПОСТРОЧНО тем же предикатом:
    // `DECISION_LINE` знает две формы записи поля, и повторять их здесь нельзя.
    const re = new RegExp(`\\*\\*\\s*${escapeRe(label)}`, 'i');
    return lines.some((line) => re.test(line) && isDecisionLine(line));
  });
}

/**
 * Принадлежит ли строка-продолжение (с `lineStart`) полю решения человека.
 *
 * Обход вверх до первой строки элемента списка, с тремя уроками ревью-5:
 *  - защита прогресса: на файле, начинающемся с пустой строки, `lastIndexOf` с
 *    отрицательным fromIndex клампится к 0 и возвращал ту же позицию — вечный
 *    синхронный цикл вешал event loop сервера (воспроизведено);
 *  - решение узнаётся и по СКЛЕЕННОМУ элементу, не только построчно: в старой форме
 *    шаблона двоеточие уезжает на продолжение («…не имя\n  оператора)_: н/п»), и ни
 *    одна строка по отдельности меткой не выглядит — а проекты, скопировавшие шаблон
 *    до канонизации, живут именно с такой формой;
 *  - каждая поднятая строка проверяется отдельно (вложенный пункт-решение не
 *    проскакивается), пробельная строка внутри элемента обход не рвёт.
 *
 * Живёт рядом с `isDecisionLine`, а не в `FormFillExecutor`: тем же вопросом задаётся
 * схема формы (`formSchema.ts`), и две копии обхода разошлись бы на первом же уроке.
 */
export function continuationOfDecision(text: string, lineStart: number): boolean {
  const lineEndIdx = text.indexOf('\n', lineStart);
  let joined = text.slice(lineStart, lineEndIdx < 0 ? text.length : lineEndIdx).trimStart();
  let start = lineStart;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd < 0) return false;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    if (prevStart >= start) return false; // пустая первая строка файла — прогресса нет
    const prev = text.slice(prevStart, prevEnd);
    joined = `${prev.trimEnd()} ${joined}`;
    if (isDecisionLine(prev) || isDecisionLine(joined)) return true;
    // Первая строка элемента (не отступная и не пробельная) достигнута и решением
    // не оказалась — выше начинается чужой элемент.
    if (prev.trim() !== '' && !/^\s+\S/.test(prev)) return false;
    start = prevStart;
  }
}

/**
 * Ячейка ШАПКИ таблицы, означающая колонку подписи человека: «Утвердил (человек)» в
 * таблице неприменимости, «Кто» / «Кто утвердил» в таблицах набора гейтов. Отдельно от
 * меток полей: в таблицах решение живёт колонкой, и жирного поля там нет. Начало ячейки,
 * а не подстрока — «Кто» внутри описания колонкой подписи не является; дефис и цифра
 * тоже не граница («Кто-то», «Кто2» — не подписные колонки). Широта словаря (все метки
 * `DECISION` как возможные имена колонок) осознанна: направление ошибки fail-closed —
 * лишняя строка-образец остаётся человеку, а не отдаётся модели.
 */
const DECISION_CELL = new RegExp(
  `^(${['Утвердил', 'Кто', ...Object.values(DECISION)].map(escapeRe).join('|')})([^\\p{L}\\d-]|$)`,
  'iu',
);

export function isDecisionCell(cell: string): boolean {
  return DECISION_CELL.test(cell.trim());
}

/**
 * Порча ФОРМЫ поля решения: поля нет там, где оно обязано быть, — обычно потому, что
 * модель переписала или удалила строку. Отдельный класс, чтобы вызывающие (bench-драйвер)
 * отличали её от программных поломок раннера типизированно, а не регуляркой по русскому
 * тексту сообщения (ревью-2: правка текста молча меняла классификацию через границу
 * пакетов).
 */
export class DecisionFormError extends Error {}

/** Строка текста, содержащая позицию `index`. Была скопирована в трёх файлах — теперь одна. */
export function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

export type DecisionState =
  /** Поля нет в файле — форма не та или файл не создан. */
  | { state: 'missing' }
  /** Поле есть, но решения в нём нет: плейсхолдер, пустота или оба исхода сразу. */
  | { state: 'placeholder'; raw: string; why: string }
  /** Человек решил отрицательно: «не одобрен», «не принималась — обрыв». */
  | { state: 'declined'; raw: string }
  /** Решение принято: есть имя и дата. */
  | { state: 'granted'; raw: string };

function fieldRegex(label: string): RegExp {
  // Метка встречается как «- **Одобрение:** ...» или «**Решение человека о полноте:** ...».
  return new RegExp(`^(.*\\*\\*${escapeRe(label)}:\\*\\*)(.*)$`, 'm');
}

/**
 * Сырое значение простого поля-метки («- **Ветка витка:** sdlc/auth-104») — без семантики
 * решения человека, которую несёт `readDecision`. `null` — поля нет, плейсхолдер или пусто:
 * вызывающий сам решает, что означает отсутствие значения для его конкретного поля.
 */
export function readField(text: string, label: string): string | null {
  const m = fieldRegex(label).exec(text);
  if (m === null) return null;
  const raw = (m[2] ?? '').trim();
  if (raw === '' || hasPlaceholder(raw)) return null;
  return raw;
}

/**
 * Имя ветки из значения поля «Ветка витка».
 *
 * Значение — не обязательно голое имя: модель нередко приписывает пояснение в скобках
 * («sdlc/oversize (уже заведена)», «sdlc/oversize (заведена заранее, зафиксирована в
 * task.md)») или оборачивает его в markdown-код («`sdlc/oversize`») — люди в интервью делают
 * так же. Сравнивать с деревом нужно именем ветки, а не фразой целиком: иначе поле,
 * заполненное добровольно и верно, ловило бы виток на собственной пунктуации, а не на
 * настоящем расхождении с git (обнаружено контрольным прогоном бенчмарка — первый живой
 * сквозной виток блокировался на этапе 4 всегда, дважды на двух РАЗНЫХ вариантах пунктуации).
 */
export function branchNameFromField(raw: string): string {
  const m = /^\S+/.exec(raw.trim());
  const token = m === null ? raw.trim() : m[0];
  return token.replace(/^`+|`+$/g, '');
}

/** Экранирование строки для вставки в RegExp — единственная копия на кодовую базу. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Вычеркнутое markdown-зачёркиванием человек считает удалённым — и мы тоже. */
function dropStruckThrough(s: string): string {
  return s.replace(/~~[^~]*~~/g, ' ');
}

const NEGATIVE_TRIGGER = /(^|\s)(не\s+\S+|отклон\S*|отказ\S*|отверг\S*|провал\S*)/gi;
/**
 * Слова с отрицательным значением, которые в связке с «не» дают ДВОЙНОЕ отрицание —
 * то есть положительный итог: «ни один claim не пропущен», «долг не забыт», «тест не
 * сломан». Прежняя проверка ловила голое «не » где угодно в строке и читала такие
 * согласия как отказ — обнаружено на записи «ни один claim не пропущен» вместо
 * ожидаемого одобрения.
 *
 * Список обязан включать и сами корни `NEGATIVE_TRIGGER` (отклон/отказ/отверг/провал):
 * без них «не отклонён»/«не провален»/«не отказано»/«не отвергнут» — тоже двойное
 * отрицание с положительным итогом — читались как отказ, потому что список отделял
 * форму глагола-причастия от повода, по которому вообще сработал триггер.
 */
const DOUBLE_NEGATIVE_SAFE_WORD =
  /^(пропущен\w*|забыт\w*|потерян\w*|упущен\w*|усохл\w*|сломан\w*|нарушен\w*|утрачен\w*|отклон\w*|отказ\w*|отверг\w*|провал\w*)/i;

/**
 * Корни глаголов, которыми методология выражает исход решения. Внутри скобок поле несёт
 * не сам вердикт, а пояснение к нему — прямую цитату ответа человека, перечень пунктов
 * сферы правки («класс не переименовываем»). Там `NEGATIVE_TRIGGER` (любое «не + слово»)
 * ловит случайную реплику вместо вердикта: «Иван · 2026-08-25 (через ask_human:
 * «Подтверждаю как в плане» — …, класс не переименовываем)» в целом читалось как отказ.
 * Внутри скобок триггер обязан целиться в сам глагол решения, а не в «не» как таковое —
 * вне скобок (сам вердикт, каким его пишет форма — «**не одобрен**», «не использовано
 * одобрение плана через ExitPlanMode») это сужение неверно, там нужен широкий триггер.
 */
const DECISION_VERB_ROOTS =
  'одобр\\S*|приним\\S*|принял\\S*|подтвержд\\S*|соглас\\S*|поддерж\\S*|разреш\\S*|отклон\\S*|отказ\\S*|отверг\\S*|провал\\S*';
const PAREN_NEGATIVE_TRIGGER = new RegExp(
  `(^|\\s)(не\\s+(?:${DECISION_VERB_ROOTS})|отклон\\S*|отказ\\S*|отверг\\S*|провал\\S*)`,
  'gi',
);

/** Символы вне/внутри круглых скобок — остальные позиции заменены пробелом, чтобы не
 * склеить соседние слова и не сдвинуть индексы. Вложенность скобок не поддерживается —
 * форма полей её не использует. */
function splitByParens(s: string): { outside: string; inside: string } {
  let depth = 0;
  let outside = '';
  let inside = '';
  for (const ch of s) {
    if (ch === '(') {
      depth++;
      outside += ' ';
      inside += ' ';
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      outside += ' ';
      inside += ' ';
      continue;
    }
    if (depth > 0) {
      outside += ' ';
      inside += ch;
    } else {
      outside += ch;
      inside += ' ';
    }
  }
  return { outside, inside };
}

function scanForDecline(s: string, trigger: RegExp): boolean {
  const re = new RegExp(trigger.source, trigger.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const token = m[2] ?? '';
    const neWord = /^не\s+(\S+)/i.exec(token);
    if (neWord !== null && DOUBLE_NEGATIVE_SAFE_WORD.test(neWord[1] ?? '')) continue;
    return true;
  }
  return false;
}

/** «Похоже на отказ» — с поправкой на двойное отрицание и на скобочные пояснения. */
function looksDeclined(s: string): boolean {
  const { outside, inside } = splitByParens(s);
  return scanForDecline(outside, NEGATIVE_TRIGGER) || scanForDecline(inside, PAREN_NEGATIVE_TRIGGER);
}

const PENDING = /(ожида|не\s*реш|tbd|todo|^[\s—–\-?.]*$|н\/п)/i;

/**
 * Вторая законная ветка формы журнала chunk'а: «использовано одобрение плана через
 * ExitPlanMode этой сессии».
 *
 * Даты в ней нет по построению — решение принято в живой сессии и записано ссылкой на
 * неё, а не подписью. Требование «имя И дата» без этого исключения блокировало этап 6
 * на журнале, оформленном ровно так, как велит форма эталона.
 */
const SESSION_APPROVAL = /одобрени[ея]\s+плана\s+через\s+ExitPlanMode/i;

export function readDecision(text: string, label: string): DecisionState {
  const m = fieldRegex(label).exec(text);
  if (m === null) return { state: 'missing' };

  const rawFull = (m[2] ?? '').trim();
  if (rawFull === '' || hasPlaceholder(rawFull)) {
    return { state: 'placeholder', raw: rawFull, why: 'поле не заполнено' };
  }

  const raw = dropStruckThrough(rawFull).replace(/\s+/g, ' ').trim();
  if (raw === '') return { state: 'declined', raw: rawFull };

  const stripped = raw.replace(/\*\*/g, '').trim();

  // Оба исхода остались в строке через « / » — человек не вычеркнул лишний, значит
  // решения нет. Раньше такая строка читалась как одобрение.
  if (stripped.includes(' / ')) {
    const sides = stripped.split(' / ').map((s) => s.trim());
    const anyNegative = sides.some((s) => looksDeclined(s));
    const anySigned = sides.some((s) => isSignedByHuman(s) || SESSION_APPROVAL.test(s));
    if (anyNegative && !anySigned) return { state: 'declined', raw: rawFull };
    if (anyNegative && anySigned) {
      return {
        state: 'placeholder',
        raw: rawFull,
        why: 'в поле остались оба исхода — человек не вычеркнул лишний',
      };
    }
  }

  if (looksDeclined(stripped)) return { state: 'declined', raw: rawFull };

  if (PENDING.test(stripped)) {
    return { state: 'placeholder', raw: rawFull, why: 'решение отложено' };
  }

  // Ссылка на одобрение живой сессии — законный вариант формы, и даты в нём нет.
  // Проверяется ПОСЛЕ отрицания и отложенности, а не до: «ожидается одобрение плана через
  // ExitPlanMode» — это ожидание, а не одобрение, и обратный порядок читал его как
  // состоявшееся решение человека.
  if (SESSION_APPROVAL.test(stripped)) return { state: 'granted', raw: rawFull };

  const problem = signatureProblem(stripped);
  if (problem !== null) {
    return {
      state: 'placeholder',
      raw: rawFull,
      why: `${problem} — методология требует записи «имя · дата», а не отметки`,
    };
  }

  return { state: 'granted', raw: rawFull };
}

/** Записывает решение в поле, заменяя всё после метки. Возвращает новый текст. */
export function setDecision(text: string, label: string, value: string): string {
  const re = fieldRegex(label);
  if (!re.test(text)) {
    throw new DecisionFormError(
      `в артефакте нет поля «${label}» — форма не соответствует шаблону методологии`,
    );
  }
  return text.replace(re, (_full, head: string) => `${head} ${value}`);
}

/** «Иван · 2026-08-16» — форма, которую ожидают шаблоны. */
export function decisionValue(operator: string, date: Date): string {
  return `${operator} · ${date.toISOString().slice(0, 10)}`;
}

// Форма «решение получено не от живого человека» (пометка источника + запрет публикации)
// здесь была, но неинтерактивного прогона в рантайме нет: решения приходят только из
// интерфейса, от оператора. Заготовка под несуществующий режим создавала впечатление,
// что такой режим предусмотрен и проверен, — удалена вместе с ним.
