/**
 * Извлечение ответов человека из clarification-report.md — общий вход для двух потребителей:
 * карточки «Факты от человека» в промпте chunk'а и гейта «Ответы человека в коде».
 *
 * Порог, ради которого это заведено, замерен сериями r7–r8 (`docs/model-runs.md`): модели
 * класса ≤8 ГБ пишут корректный код, но теряют факт из диалога по дороге через длинный
 * контекст — human-кейсы 0–1/3 против 3/3 у 14B. Экстрактор один на оба потребителя
 * намеренно: посчитай «что считается ответом человека» в двух местах — и промпт будет
 * обещать одно, а гейт проверять другое.
 *
 * Никакой интерпретации: берётся таблица «Вопросы и ответы» шаблона методологии, строка с
 * настоящим ответом (не «(пропущено)», не плейсхолдер). Литералы — то, что механически
 * проверяемо в diff: числа и цитаты в кавычках. Ответ без литералов фактом остаётся, но
 * гейтом не проверяется — сверять «на общих основаниях» с кодом машина не умеет и не
 * изображает, что умеет.
 */

import { LEADING_PIPE_SEPARATOR_RE, columnIndex, escapeCell, h2SectionRanges, parseTables, splitRow } from '../md/table.ts';
import { escapeRe } from './artifact.ts';

export interface HumanFact {
  question: string;
  answer: string;
  /**
   * Механически проверяемые кусочки ответа. У каждого литерала — список принимаемых
   * написаний: «90%» в коде законно живёт и как `90`, и как `0.9`.
   */
  literals: { shown: string; accepted: string[] }[];
}

/** Плейсхолдер шаблона — строка не заполнена, ответом не является. */
const PLACEHOLDER = /[‹›]/;

/**
 * Регулярка поиска литерала-числа как ОТДЕЛЬНОГО токена в тексте diff'а.
 *
 * Живёт рядом с экстрактором намеренно: границы токена обязаны совпадать с границами
 * извлечения (буква — не граница числа в обе стороны), иначе «лимит 64» зеленел от
 * `base64` — гейт и промпт расходились ровно там, где этот файл обещает единство.
 * Экранируются ВСЕ метасимволы: форма собирается из текста ответа человека, и цитата
 * «2) особый случай» без экранирования роняла RegExp'ом весь этап 6 (ревью, К9).
 */
export function literalPattern(form: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\d.])${escapeRe(form)}([^\\p{L}\\d.]|$)`, 'mu');
}

/**
 * Литералы ответа: числа (с процентной альтернативой) и цитаты «…»/"…"/`…`.
 * Числа внутри слов не берутся — регулярка требует нецифровое окружение.
 */
export function literalsOf(answer: string): { shown: string; accepted: string[] }[] {
  const out: { shown: string; accepted: string[] }[] = [];
  const seen = new Set<string>();

  // Префикс исключает и буквы: «utf8» — не число 8, а часть слова.
  for (const m of answer.matchAll(/(^|[^\p{L}\d.,])(\d+(?:[.,]\d+)?)(\s*%)?/gu)) {
    const num = m[2]!;
    const isPercent = m[3] !== undefined;
    const shown = isPercent ? `${num}%` : num;
    if (seen.has(shown)) continue;
    seen.add(shown);
    const accepted = [num];
    if (num.includes(',')) accepted.push(num.replace(',', '.'));
    if (isPercent) {
      // 90% → 0.9: дробная форма ставки — обычное написание в коде. Округление до 10
      // знаков срезает двоичный артефакт: 8,2% без него давал 0.08199999999999999 —
      // форму, которой в коде не бывает, и точный перенос ответа краснел (ревью, К10).
      const frac = Number(num.replace(',', '.')) / 100;
      // Форма «0» не добавляется: микропроцент, схлопнувшийся округлением в ноль, находил
      // бы одиночный 0 почти в любом диффе — ложный зелёный (ревью-2).
      if (Number.isFinite(frac) && frac > 0) {
        const s = String(Number(frac.toFixed(10)));
        if (s !== '0') accepted.push(s);
      }
    }
    out.push({ shown, accepted });
  }

  for (const m of answer.matchAll(/«([^»]+)»|"([^"]+)"|`([^`]+)`/g)) {
    const quoted = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (quoted === '' || quoted.length > 120 || seen.has(quoted)) continue;
    seen.add(quoted);
    out.push({ shown: `«${quoted}»`, accepted: [quoted] });
  }

  return out;
}

/**
 * Ответы человека из текста clarification-report.md. Пустой массив — отчёта нет по
 * содержанию: таблица не заполнена, все ответы пропущены либо остались плейсхолдерами.
 */
export function extractHumanFacts(text: string): HumanFact[] {
  // Границы секции — общим h2SectionRanges: h3-подзаголовок внутри «Вопросы и ответы»
  // не закрывает её (тот же класс, что пойман на карте кодовой базы, ревью-3/4).
  const range = h2SectionRanges(text, /вопросы и ответы/i)[0];
  if (range === undefined) return [];
  const section = text.slice(range.start, range.end);

  // Общий разборщик таблиц, а не построчный полуразбор: колонки находятся по именам
  // шапки, а не магическими индексами — сдвиг формы таблицы ломался бы молча (ревью-2).
  const out: HumanFact[] = [];
  for (const table of parseTables(section)) {
    let qi = columnIndex(table.header, 'Вопрос');
    let ai = columnIndex(table.header, 'Ответ');
    // Неканоничная шапка (модель сократила имена колонок) — позиционный запасной ход по
    // форме шаблона «| # | Вопрос | Блокирующий | Ответ | … |»: без него потеря шапки
    // делала гейт «Ответы человека в коде» зелёным «сверять нечего» — ложный зелёный на
    // ровном месте (ревью-3). Требуются все пять колонок формы, иначе таблица не наша.
    // Индексы 1/3 — намеренная копия ПОРЯДКА колонок шаблона: смена порядка в эталоне
    // требует правки здесь; цена принята, альтернатива — молчаливый зелёный.
    // Найденный по имени индекс НЕ перетирается (ревью-4); полностью безымянная шапка —
    // возможно, съеденная parseTables первая строка данных, и она сканируется как данные.
    const positional = qi < 0 && ai < 0 && table.header.length >= 5;
    if (positional) {
      qi = 1;
      ai = 3;
    }
    // Смешанный режим (одна колонка нашлась по имени, вторая — нет) позиционным ходом
    // не спасается: форма заведомо не шаблонная, и индекс 3 указывал бы в чужую колонку
    // («Блокирующий» уходил ложным фактом answer='да' — ревью-5). Таблица пропускается
    // целиком — fail-closed.
    if (qi < 0 || ai < 0) continue;
    for (const row of positional ? [table.header, ...table.rows] : table.rows) {
      // В позиционном режиме первая строка может оказаться и настоящей шапкой — её
      // выдаёт «#» в колонке номера, фактом она не является.
      if (positional && (row[0] ?? '').trim() === '#') continue;
      const question = (row[qi] ?? '').trim();
      const answer = (row[ai] ?? '').trim();
      if (question === '' || answer === '') continue;
      if (PLACEHOLDER.test(question) || PLACEHOLDER.test(answer)) continue;
      if (answer.startsWith('(пропущено)')) continue;
      out.push({ question, answer, literals: literalsOf(answer) });
    }
  }
  return out;
}

const OPEN_QUESTIONS_HEADING_RE = /Открытые вопросы/i;
/**
 * Строка чек-бокса задачи: `- [ ] **[блокирующий]** ‹вопрос›`. Тег важности необязателен
 * в захвате — старая запись без него (или ручная правка человека) всё равно закрывается.
 *
 * Между скобками — ЛЮБОЕ число пробельных символов вокруг необязательной отметки, не ровно
 * один: страж `preconditions.ts::hasOpenQuestions` (тот же класс строки, другая проверка)
 * уже был терпимее (`\[\s*\]`) и видел вопрос открытым там, где этот регэксп его не
 * распознавал вовсе (`- [  ] …`, два пробела) — вопрос навсегда оставался «есть, но
 * незакрываемым»: страж не пропускал этап, а сам механизм задавания/закрытия его не видел
 * (ревью code-review-all, 2026-09-19). Группа отметки — необязательный ОДИН символ
 * (`x`/`X`, пусто — открыт), а не «ровно то, что было между скобками» — восстановленная
 * строка нормализует произвольные пробелы к каноничному `[x]`.
 */
const CHECKBOX_LINE_RE = /^(\s*[-*+]\s*\[)\s*([xX]?)\s*(\]\s*(?:\*\*\[(?:блокирующий|неблокирующий)\]\*\*\s*)?)(.+)$/;

/** То же нормализующее сравнение текста вопроса, что и для литералов — без учёта регистра и пробелов. */
function normalizeQuestion(s: string): string {
  // `ё→е` — та же свёртка, что уже применяет `gateKey` (`gates/gatesFile.ts`) для того же
  // класса риска: два написания одного вопроса («ещё» / «еще») не должны читаться как
  // разные вопросы (ревью code-review-all, 2026-09-19).
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Закрывает чек-боксы «Открытых вопросов» задачи ответами из `clarification-report.md`
 * (3.1, «closeAnsweredQuestions»): `- [ ] **[блокирующий]** ‹вопрос›` → `- [x] **[блокирующий]**
 * ‹вопрос› — ‹ответ›`. Рантайм пишет `intent.md` мимо инструментов модели тем же путём, что
 * и остальные `mechanicalJobs` (`Run.writeAutofilled`) — `intent.md` защищён от записи
 * МОДЕЛЬЮ на этапе `ask` (`RUNTIME_PROTECTED`), но это ограничение стоит на политике
 * инструментов, а не на самом файле, и рантаймовую механическую запись не касается.
 *
 * Закрывает ровно измеренный конфликт (#9, `docs/model-runs.md`): скилл велит модели самой
 * закрыть ответ в `intent.md`, рантайм её `Edit` туда отклоняет — 25 ходов цикла «правка →
 * отказ → „начать план?“». Модели закрывать нечего по построению: вопрос закрывается уже
 * тем, что она вписала ответ в таблицу отчёта.
 *
 * Пропущенный вопрос («(пропущено)», уже отфильтрован `extractHumanFacts`) НЕ закрывается:
 * шаблон отчёта сам требует, чтобы отложенные неблокирующие вопросы «оставались открытыми
 * в задаче — уходили следующему витку, а не исчезали» («Отложено»). Сопоставление —
 * НОРМАЛИЗОВАННЫЙ (регистр, пробелы), но точный текст, не похожесть: разные вопросы с
 * похожей формулировкой не должны схлопнуться в один.
 */
export function closeAnsweredQuestions(
  intentText: string,
  facts: readonly HumanFact[],
): { text: string; closed: number } {
  const range = h2SectionRanges(intentText, OPEN_QUESTIONS_HEADING_RE)[0];
  if (range === undefined) return { text: intentText, closed: 0 };

  const byQuestion = new Map<string, HumanFact>();
  for (const f of facts) {
    const key = normalizeQuestion(f.question);
    if (key !== '') byQuestion.set(key, f);
  }
  if (byQuestion.size === 0) return { text: intentText, closed: 0 };

  const before = intentText.slice(0, range.start);
  const section = intentText.slice(range.start, range.end);
  const after = intentText.slice(range.end);

  let closed = 0;
  const newSection = section
    .split('\n')
    .map((line) => {
      // CRLF: шаблоны методологии несут `\r\n`, а `(.+)$` без `\r` в хвосте строки не
      // матчится вовсе (`.` не ест `\r`, `$` без `m` не встаёт перед одиночным `\r`) —
      // строка молча оставалась незакрытой на живом шаблоне (найдено сверкой с эталоном).
      // `\r` отделяется и возвращается на место, а не отбрасывается — файл не мешает
      // стили окончания строк на нетронутых строках.
      const hadCR = line.endsWith('\r');
      const bare = hadCR ? line.slice(0, -1) : line;
      const m = CHECKBOX_LINE_RE.exec(bare);
      if (m === null) return line;
      const [, open, mark, tag, questionRaw] = m;
      if (mark !== '') return line; // уже закрыт — идемпотентно (mark пуст ⇔ открыт)
      const fact = byQuestion.get(normalizeQuestion(questionRaw ?? ''));
      if (fact === undefined) return line;
      closed++;
      const rebuilt = `${open}x${tag}${(questionRaw ?? '').trim()} — ${fact.answer}`;
      return hadCR ? `${rebuilt}\r` : rebuilt;
    })
    .join('\n');

  return { text: before + newSection + after, closed };
}

// ---------------------------------------------------------------------------
// Вопрос человеку задаёт рантайм, не модель (3.4 / S1: «Один механизм полей человека»)
// ---------------------------------------------------------------------------

export interface OpenQuestion {
  /** Текст как записан в чек-боксе — дословно, без изменений. */
  question: string;
  blocking: boolean;
  source: 'intent' | 'exploration';
}

/**
 * Открытые вопросы чек-боксами из `intent.md` («Открытые вопросы») и
 * `exploration-report.md` («Всплывшие вопросы») — оба шаблона несут ОДНУ и ту же форму
 * строки (`- [ ] **[блокирующий]** ‹вопрос›`), и вопрос уже полностью сформулирован тем,
 * кто его завёл (модель этапа 1 или этапа 2) — рантайму этапа `ask` остаётся только
 * задать его человеку напрямую, не изобретая формулировку заново.
 *
 * Строка-образец (`‹вопрос›`) и уже закрытые (`[x]`) чек-боксы не возвращаются.
 */
export function openQuestions(intentText: string, explorationText: string): OpenQuestion[] {
  const all = [
    ...questionsInSection(intentText, /Открытые вопросы/i, 'intent'),
    ...questionsInSection(explorationText, /Всплывшие вопросы/i, 'exploration'),
  ];
  // Дедуп по нормализованному тексту (ревью code-review-all, 2026-09-19): разведка нередко
  // буквально повторяет уже заданный вопрос задачи — без дедупа рантайм задавал бы человеку
  // один и тот же вопрос дважды за вход, тратя слот `MAX_QUESTIONS_PER_TURN` впустую. Первое
  // вхождение выигрывает — источник (`intent`/`exploration`) роли не играет.
  const seen = new Set<string>();
  return all.filter((q) => {
    const key = normalizeQuestion(q.question);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function questionsInSection(
  text: string,
  headingRe: RegExp,
  source: OpenQuestion['source'],
): OpenQuestion[] {
  const range = h2SectionRanges(text, headingRe)[0];
  if (range === undefined) return [];
  const section = text.slice(range.start, range.end);
  const out: OpenQuestion[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine; // CRLF, см. closeAnsweredQuestions
    const m = CHECKBOX_LINE_RE.exec(line);
    if (m === null) continue;
    const [, , mark, tag, questionRaw] = m;
    if (mark !== '') continue; // уже закрыт (mark пуст ⇔ открыт)
    const question = (questionRaw ?? '').trim();
    if (question === '' || PLACEHOLDER.test(question)) continue;
    // Отсутствие тега (старая запись без `**[…]**`) считается блокирующим по умолчанию —
    // молчание безопаснее в сторону «спросить раньше», чем в сторону «пропустить».
    const blocking = !/\[неблокирующий\]/i.test(tag ?? '');
    out.push({ question, blocking, source });
  }
  return out;
}

const QA_HEADING_RE = /вопросы и ответы/i;

/**
 * Вопросы, УЖЕ несущие строку в таблице «Вопросы и ответы» — отвеченные ИЛИ честно
 * помеченные «(пропущено)». Оба исхода значат «рантайм уже спросил»: идемпотентность
 * держится на самом факте строки, а не на наличии настоящего ответа —
 * `extractHumanFacts` пропущенные строки не видит вовсе (не факт по её контракту), и
 * использовать её здесь означало бы переспрашивать пропущенный вопрос на каждом входе
 * в этап.
 */
function askedQuestionTexts(reportText: string): Set<string> {
  const out = new Set<string>();
  const range = h2SectionRanges(reportText, QA_HEADING_RE)[0];
  if (range === undefined) return out;
  const section = reportText.slice(range.start, range.end);
  for (const table of parseTables(section)) {
    const qi = columnIndex(table.header, 'Вопрос');
    if (qi < 0) continue;
    for (const row of table.rows) {
      const q = (row[qi] ?? '').trim();
      if (q === '' || PLACEHOLDER.test(q)) continue;
      out.add(normalizeQuestion(q));
    }
  }
  return out;
}

/** Открытые вопросы, которым ещё НЕТ строки в отчёте — вход рантайм-вопроса этой попытки. */
export function unaskedQuestions(open: readonly OpenQuestion[], reportText: string): OpenQuestion[] {
  const asked = askedQuestionTexts(reportText);
  return open.filter((q) => !asked.has(normalizeQuestion(q.question)));
}

/** Сколько вопросов уже несут строку в отчёте — нумерация продолжает, не начинает заново. */
export function askedQuestionCount(reportText: string): number {
  return askedQuestionTexts(reportText).size;
}

/**
 * Строка таблицы «Вопросы и ответы» для вопроса, заданного рантаймом. `answer === null` —
 * человек пропустил (кнопка «Пропустить» в интерфейсе, пустой ответ). Колонка «Что
 * изменилось в задаче» остаётся полем МОДЕЛИ: решить, как ответ меняет намерение задачи —
 * суждение, а не факт, и рантайм его не изображает.
 */
export function renderAnswerRow(n: number, q: OpenQuestion, answer: string | null): string {
  const ans = answer === null ? '(пропущено)' : escapeCell(answer);
  return `| ${n} | ${escapeCell(q.question)} | ${q.blocking ? 'да' : 'нет'} | ${ans} | ‹что изменилось в задаче› |`;
}

/**
 * Дописывает готовые строки в таблицу «Вопросы и ответы», заменяя строку-образец, если
 * она к этому моменту ещё единственная, — тот же приём, что `seedFilesToTouch` для
 * `files_to_touch` плана: плейсхолдер уходит, как только появляется первая настоящая
 * строка, а настоящие строки прошлых вызовов остаются на месте.
 *
 * «Образец» проверяется по ячейке «Вопрос» (индекс 1), а не по всей строке целиком: у
 * КАЖДОЙ строки, которую рисует `renderAnswerRow`, последняя ячейка («Что изменилось в
 * задаче») — намеренный плейсхолдер для модели, и сканирование всей строки на `‹…›`
 * принимало настоящую, уже записанную рантаймом строку за образец и стирало её на
 * следующем вызове.
 */
export function appendAnswerRows(reportText: string, rows: readonly string[]): string {
  if (rows.length === 0) return reportText;
  const range = h2SectionRanges(reportText, QA_HEADING_RE)[0];
  if (range === undefined) return reportText;
  const section = reportText.slice(range.start, range.end);
  const lines = section.split('\n');
  const separatorAt = lines.findIndex((l) => LEADING_PIPE_SEPARATOR_RE.test(l.trim()));
  if (separatorAt < 0) return reportText;
  let rowsEnd = separatorAt + 1;
  while (rowsEnd < lines.length && lines[rowsEnd]!.trim().startsWith('|')) rowsEnd++;
  const existing = lines.slice(separatorAt + 1, rowsEnd);
  const real = existing.filter((l) => {
    const cells = splitRow(l);
    const question = cells[1] ?? '';
    return question.trim() !== '' && !PLACEHOLDER.test(question);
  });
  const merged = [...real, ...rows];
  const newLines = [...lines.slice(0, separatorAt + 1), ...merged, ...lines.slice(rowsEnd)];
  const newSection = newLines.join('\n');
  return reportText.slice(0, range.start) + newSection + reportText.slice(range.end);
}
