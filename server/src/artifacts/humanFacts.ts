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

import { splitRow } from '../md/table.ts';

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
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\d.])${esc}([^\\p{L}\\d.]|$)`, 'mu');
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
      if (Number.isFinite(frac)) accepted.push(String(Number(frac.toFixed(10))));
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
  const start = text.indexOf('## Вопросы и ответы');
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end < 0 ? rest : rest.slice(0, end);

  const out: HumanFact[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    // Разбор строки — общим `splitRow`: он знает про экранированную `\|`, на которой
    // наивный split('|') рвал ячейку с чертой и сдвигал колонку ответа (ревью, К19).
    const cells = splitRow(line);
    // | # | Вопрос | Блокирующий | Ответ человека | Что изменилось |
    if (cells.length < 4) continue;
    const [num, question, , answer] = cells;
    if (num === undefined || question === undefined || answer === undefined) continue;
    if (num === '#' || /^:?-+:?$/.test(num) || num === '') continue;
    if (PLACEHOLDER.test(question) || PLACEHOLDER.test(answer)) continue;
    if (answer === '' || answer.startsWith('(пропущено)')) continue;
    out.push({ question, answer, literals: literalsOf(answer) });
  }
  return out;
}
