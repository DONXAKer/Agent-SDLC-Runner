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
 * Угловые ASCII-скобки считаются наравне с типографскими: редактор без типографских
 * кавычек превращает `‹…›` в `<…>` при первом же сохранении, и артефакт с незаполненной
 * формой начинал считаться готовым здесь, оставаясь незаполненным для разбора набора
 * гейтов и отчёта приёмки. Одно понятие — одно определение, отсюда экспорт.
 */
export const PLACEHOLDER_RE = /[‹<][^›<>]*[›>]/g;

/** Есть ли в значении незаполненное место. Для одной ячейки, а не для файла целиком. */
export function hasPlaceholder(value: string): boolean {
  return new RegExp(PLACEHOLDER_RE.source).test(value);
}

/** Подпись человека: имя и дата в любом внятном написании. */
const HAS_DATE = /\d{4}-\d{2}-\d{2}|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/;
const HAS_NAME = /\p{L}{2,}/u;

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

export function writeArtifact(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function countPlaceholders(text: string): number {
  const m = text.match(PLACEHOLDER_RE);
  return m === null ? 0 : m.length;
}

/** Позиции незаполненных мест — для подсветки в редакторе артефакта. */
export function placeholderRanges(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
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
} as const;

export type DecisionLabel = (typeof DECISION)[keyof typeof DECISION];

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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Вычеркнутое markdown-зачёркиванием человек считает удалённым — и мы тоже. */
function dropStruckThrough(s: string): string {
  return s.replace(/~~[^~]*~~/g, ' ');
}

const NEGATIVE = /(^|\s)(не\s|отклон|отказ|отверг|провал)/i;
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
    const anyNegative = sides.some((s) => NEGATIVE.test(s));
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

  if (NEGATIVE.test(stripped)) return { state: 'declined', raw: rawFull };

  // Ссылка на одобрение живой сессии — законный вариант формы, и даты в нём нет.
  if (SESSION_APPROVAL.test(stripped)) return { state: 'granted', raw: rawFull };

  if (PENDING.test(stripped)) {
    return { state: 'placeholder', raw: rawFull, why: 'решение отложено' };
  }

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
    throw new Error(
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
