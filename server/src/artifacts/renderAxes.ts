/**
 * Запись ответов `planAxisFill` в таблицу «Последствия шагов» плана.
 *
 * Обратная сторона `planAxes.ts`: та ТОЛЬКО читает уже написанный текст, эта ТОЛЬКО
 * дописывает — точечно, построчно, не трогая ничего, кроме перечисленных осей. Разбор и
 * запись сознательно разведены по разным файлам: 449 строк тестов `planAxes.test.ts`
 * проверяют разбор, и они не должны сдвинуться от правки логики записи.
 *
 * Работает по СТРОКАМ текста, а не по `parseTables`/`MdTable` (та форма не несёт позиций в
 * исходном тексте — офсетов, по которым можно было бы заменить ровно одну строку и оставить
 * остальные байт-в-байт). Ось с уже существующей строкой — эта строка заменяется целиком;
 * ось без строки — новая строка дописывается в конец таблицы осей той же секции.
 */

import { escapeCell, headerKey, isSeparatorRow, splitRow } from '../md/table.ts';
import { AXES, readAffected, type AxisName } from './planAxes.ts';

export interface AxisFillAnswer {
  axis: AxisName;
  /** Ячейка «Затронута шагами» как есть — «да»/«нет». */
  affectedText: string;
  /** Ячейка «Что именно в шагах». */
  what: string;
  /** Ячейка «Исход» — уже готовый текст словаря (`claim-3`, `н/п — …` и т.п.). */
  outcome: string;
  /**
   * Заполнено, когда `outcome` — «риск»: подписи под принятым риском нет намеренно (риски
   * принимаются полем «Одобрение» плана целиком), поэтому единственное, что отличает решение
   * от забывания, — причина и срок пересмотра, и они идут ОТДЕЛЬНОЙ таблицей, не в этой ячейке.
   */
  risk?: { what: string; why: string; revisit: string };
}

/** Та же нормализация имени, что `planAxes.ts`: без подчёркиваний, ключ колонки/значения. */
function axisKey(s: string): string {
  return headerKey(s.replace(/_/g, ''));
}

const CANONICAL_BY_KEY = new Map<string, AxisName>(AXES.map((a) => [axisKey(a), a]));

function axisRowLine(a: AxisFillAnswer): string {
  return `| ${a.axis} | ${escapeCell(a.affectedText)} | ${escapeCell(a.what)} | ${escapeCell(a.outcome)} |`;
}

/**
 * Та же эвристика, что `kindOfTable` в `planAxes.ts` использует для таблиц без шапки
 * (виток из терминала, шапку теряет модель): вторая ячейка данных читается как «да»/«нет».
 * Общий `readAffected`, а не своя копия — расхождение двух копий этой проверки уже стоило
 * дорого на паре «писатель читает шапку буквально / читатель её теряет» (см. докстринг
 * основного цикла `applyAxisAnswers`).
 */
function looksLikeAxisRow(cells: readonly string[]): boolean {
  return readAffected(cells[1] ?? '') !== null;
}

/**
 * Дописывает ответы `planAxisFill` в текст плана. Осей без ответа в `answers` — не трогает;
 * секции «Последствия шагов» нет вовсе — возвращает текст без изменений (вызывающий обязан
 * был проверить наличие секции раньше, тем же способом, что `planAxisProblems`).
 */
export function applyAxisAnswers(planText: string, answers: readonly AxisFillAnswer[]): string {
  if (answers.length === 0) return planText;
  const byAxis = new Map(answers.map((a) => [a.axis, a]));
  const remaining = new Set(byAxis.keys());

  const lines = planText.split(/\r?\n/);

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const h2 = /^##\s+(.+)$/.exec(lines[i]!.trim());
    if (h2 === null) continue;
    if (sectionStart === -1) {
      if (/^последстви\S*\s+шагов$/i.test(h2[1]!.trim())) sectionStart = i;
      continue;
    }
    sectionEnd = i;
    break;
  }
  if (sectionStart === -1) return planText;

  // Таблица осей — ПЕРВАЯ таблица секции под шапкой «Ось …» (шаблон методологии кладёт её
  // раньше таблицы принятых рисков). Вторая встреченная шапка «Ось …» — уже таблица рисков,
  // и это ЖЁСТКАЯ граница: слабая модель, перепутавшая таблицу осей со списком пунктов
  // задачи (строки «claim-1»…«claim-8» вместо названий осей канона), не даёт здесь ни
  // одного канонического совпадения — без этой границы сканирование проходило мимо всей
  // таблицы осей насквозь и находило канонические имена уже в таблице РИСКОВ, переписывая
  // её строки поверх (живой замер 2026-09-09, axisfill-gptossrf-1: все 6 ответов топ-апа
  // ушли в чужую таблицу, «Последствия шагов» остались незаполненными).
  //
  // Состояние тройное, не булево: `before` — ещё не вошли в таблицу осей; `axis` — внутри
  // неё (с шапкой ИЛИ без — `planAxes.ts`'s `kindOfTable` тоже поддерживает потерянную
  // шапку эвристикой «вторая ячейка похожа на да/нет», см. `looksLikeAxisRow`); `done` —
  // таблица осей кончилась (вторая шапка «Ось …», либо строка вне таблицы до того, как
  // таблица вообще началась). Без промежуточного состояния безголовая таблица осей была бы
  // неотличима от «мы ещё не вошли в таблицу», и первая же реальная шапка «Ось …» РИСКОВ
  // принималась бы за шапку осей, а строки риска — молчаливо пропускались.
  let state: 'before' | 'axis' | 'done' = 'before';
  // Последняя строка (шапка/разделитель/данные), ещё относящаяся к таблице осей — конец
  // таблицы, куда дописывать недостающие строки, даже если ни одна из них не совпала с
  // каноном (иначе вставка падала на `sectionStart + 1` — внутрь описания секции, а не в
  // таблицу).
  let axisTableEndIdx = -1;
  for (let i = sectionStart + 1; i < sectionEnd && state !== 'done'; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (isSeparatorRow(line)) {
      if (state === 'axis') axisTableEndIdx = i;
      continue;
    }
    const cells = splitRow(line);
    const name = (cells[0] ?? '').trim();
    if (name === '') continue;
    const headKey = axisKey(name);
    if (headKey === 'ось') {
      if (state === 'before') {
        state = 'axis';
        axisTableEndIdx = i;
      } else {
        state = 'done'; // вторая шапка «Ось …» — уже таблица рисков, не наша
      }
      continue;
    }
    if (state === 'before') {
      if (!looksLikeAxisRow(cells)) {
        state = 'done'; // строка раньше шапки таблицы осей и не похожа на строку оси
        continue;
      }
      state = 'axis'; // безголовая таблица осей — опознали по форме первой строки данных
    }
    axisTableEndIdx = i;
    const canonical = CANONICAL_BY_KEY.get(headKey);
    // Своя ось проекта сверх канона (в `answers` такой не будет) — строка остаётся как есть,
    // но конец таблицы (`axisTableEndIdx`) на ней всё равно сдвигается.
    if (canonical !== undefined && remaining.has(canonical)) {
      lines[i] = axisRowLine(byAxis.get(canonical)!);
      remaining.delete(canonical);
    }
  }

  if (remaining.size > 0) {
    const insertAt = axisTableEndIdx === -1 ? sectionStart + 1 : axisTableEndIdx + 1;
    const newLines = AXES.filter((a) => remaining.has(a)).map((a) => axisRowLine(byAxis.get(a)!));
    lines.splice(insertAt, 0, ...newLines);
    sectionEnd += newLines.length;
  }

  const withRisks = answers.filter(
    (a): a is AxisFillAnswer & { risk: { what: string; why: string; revisit: string } } => a.risk !== undefined,
  );
  if (withRisks.length > 0) applyRiskRows(lines, sectionStart, sectionEnd, withRisks);

  return lines.join('\n');
}

const RISK_HEADER = '| Ось | Риск словами | Почему принимаем | Когда вернуться |';
const RISK_SEPARATOR = '|---|---|---|---|';

function riskRowLine(axis: AxisName, risk: { what: string; why: string; revisit: string }): string {
  return `| ${axis} | ${escapeCell(risk.what)} | ${escapeCell(risk.why)} | ${escapeCell(risk.revisit)} |`;
}

/**
 * Дописывает/заменяет строки таблицы принятых рисков — отдельным проходом ПОСЛЕ строк осей,
 * потому что вставка новых осевых строк сдвигает номера строк, на которые опирался бы один
 * общий проход. Таблицы рисков нет вовсе (секция закрыта прозой «принятых рисков нет» или
 * пуста) — строится с нуля и вставляется в конец секции.
 */
function applyRiskRows(
  lines: string[],
  sectionStart: number,
  sectionEnd: number,
  withRisks: readonly (AxisFillAnswer & { risk: { what: string; why: string; revisit: string } })[],
): void {
  const byAxis = new Map(withRisks.map((a) => [a.axis, a]));
  const remaining = new Set(byAxis.keys());

  // То же тройное состояние, что в `applyAxisAnswers` — таблица осей перед этой может быть
  // и БЕЗ шапки (`looksLikeAxisRow`), и тогда первая же шапка «Ось …», встреченная здесь,
  // это уже шапка таблицы РИСКОВ, а не осей: без разбора состояний она принималась бы за
  // шапку осей, и настоящие строки риска пропускались бы целиком (ревью).
  let state: 'before' | 'axis' | 'risk' = 'before';
  let headerIdx = -1;
  // Последняя строка (шапка/разделитель/данные) ТАБЛИЦЫ РИСКОВ — конец таблицы, куда
  // вставлять недостающие строки, даже если данных в ней нет вовсе: без отдельного
  // отслеживания разделителя вставка ошибочно падала на позицию самого разделителя, сдвигая
  // его ПОСЛЕ новых строк и ломая markdown-таблицу (ревью, живой замер 2026-09-09).
  let lastLineIdx = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (isSeparatorRow(line)) {
      if (state === 'risk') lastLineIdx = i;
      continue;
    }
    const cells = splitRow(line);
    const first = axisKey(cells[0] ?? '');
    if (first === 'ось') {
      if (state === 'axis') {
        state = 'risk';
        headerIdx = i;
        lastLineIdx = i;
      } else if (state === 'before') {
        state = 'axis'; // шапка таблицы осей — сама таблица начинается следующей строкой
      }
      continue;
    }
    if (state === 'before') {
      if (looksLikeAxisRow(cells)) state = 'axis'; // headerless таблица осей опознана по форме
      continue;
    }
    if (state === 'axis') continue; // строка таблицы осей — не наша забота
    lastLineIdx = i;
    const canonical = CANONICAL_BY_KEY.get(first);
    if (canonical !== undefined && remaining.has(canonical)) {
      lines[i] = riskRowLine(canonical, byAxis.get(canonical)!.risk);
      remaining.delete(canonical);
    }
  }

  if (remaining.size === 0) return;

  const newRows = withRisks.filter((a) => remaining.has(a.axis)).map((a) => riskRowLine(a.axis, a.risk));

  if (headerIdx >= 0) {
    lines.splice((lastLineIdx === -1 ? headerIdx : lastLineIdx) + 1, 0, ...newRows);
    return;
  }

  // Таблицы рисков нет — строим её с нуля. Заменяем строку-прозу «принятых рисков нет»,
  // если она есть в секции; иначе дописываем таблицу в конец секции.
  let proseIdx = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/принятых\s+рисков\s+нет/i.test(lines[i]!)) {
      proseIdx = i;
      break;
    }
  }
  const table = [RISK_HEADER, RISK_SEPARATOR, ...newRows];
  if (proseIdx !== -1) {
    lines.splice(proseIdx, 1, ...table);
  } else {
    lines.splice(sectionEnd, 0, '', ...table);
  }
}
