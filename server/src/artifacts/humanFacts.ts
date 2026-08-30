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

import { columnIndex, parseTables } from '../md/table.ts';
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
  const start = text.indexOf('## Вопросы и ответы');
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end < 0 ? rest : rest.slice(0, end);

  // Общий разборщик таблиц, а не построчный полуразбор: колонки находятся по именам
  // шапки, а не магическими индексами — сдвиг формы таблицы ломался бы молча (ревью-2).
  // Нарезка секции — по h2 вручную, а не по `table.section`: parseTables сбрасывает
  // секцию на заголовке любого уровня, и h3-подзаголовок внутри «Вопросы и ответы»
  // выключал бы таблицу молча (тот же класс, что пойман в stages.ts, ревью-3).
  const out: HumanFact[] = [];
  for (const table of parseTables(section)) {
    let qi = columnIndex(table.header, 'Вопрос');
    let ai = columnIndex(table.header, 'Ответ');
    // Неканоничная шапка (модель сократила имена колонок) — позиционный запасной ход по
    // форме шаблона «| # | Вопрос | Блокирующий | Ответ | … |»: без него потеря шапки
    // делала гейт «Ответы человека в коде» зелёным «сверять нечего» — ложный зелёный на
    // ровном месте (ревью-3). Требуются все пять колонок формы, иначе таблица не наша.
    if ((qi < 0 || ai < 0) && table.header.length >= 5) {
      qi = 1;
      ai = 3;
    }
    if (qi < 0 || ai < 0) continue;
    for (const row of table.rows) {
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
