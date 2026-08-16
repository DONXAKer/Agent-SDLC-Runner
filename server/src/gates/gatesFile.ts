/**
 * Разбор `.sdlc/gates.md` — набора гейтов проекта.
 *
 * Набор — файл проекта, а не витка: он меняется раз в месяцы и служит конфигурацией
 * рантайма. Отсюда берутся три вещи: что вообще прогонять, что обязано отчитаться в
 * отчёте приёмки, и закрыт ли долг по выключенным гейтам.
 *
 * Разбор нарочно снисходителен к форматированию (пробелы, обратные кавычки, лишние
 * колонки) и строг к смыслу: непонятое значение «Вкл» — это не «да».
 */

import { parseTables } from '../md/table.ts';

const MINIMUM = [
  'Сборка',
  'Тесты',
  'Scope: файлы вне плана',
  'Анти-обход тест-гейта',
  'Ревью независимым агентом',
] as const;

export type MinimumGate = (typeof MINIMUM)[number];

/** Где гейт отчитывается. `null` — значение в наборе не распознано. */
export type ReportsAt = 'этап 1' | 'этап 2' | 'этап 4' | 'этап 5' | 'этап 6' | 'этап 7' | 'вне витка' | null;

export interface GateRow {
  name: string;
  enabled: boolean;
  /** Помечен «да — минимум»: у такой строки переключателя нет. */
  minimum: boolean;
  reportsAt: ReportsAt;
  /** Колонка «Чем реализован» как есть — она же объяснение, если команды нет. */
  implementation: string;
  /** Команда из обратных кавычек, если она там есть. Проза командой не считается. */
  command: string | null;
}

export interface DebtRow {
  name: string;
  where: string;
  how: string;
  date: string;
  who: string;
  closed: boolean;
  /** Чего не хватило для закрытия. Пусто, если закрыта. */
  why: string;
}

export interface GatesFile {
  rows: GateRow[];
  debt: DebtRow[];
}

/** `‹…›` формы — «не заполнено», а не значение. */
const PLACEHOLDER = /[‹<][^›>]*[›>]/;
const DATE = /\d{4}-\d{2}-\d{2}|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/;
const HAS_NAME = /\p{L}{2,}/u;

/** Строки таблиц секции `## <title>`: без шапки, без разделителя, без прозы. */
function tableRows(text: string, title: string): string[][] {
  const want = title.toLowerCase();
  return parseTables(text)
    .filter((t) => t.section.toLowerCase() === want)
    .flatMap((t) => t.rows);
}

function parseEnabled(cell: string): { enabled: boolean; minimum: boolean } {
  const v = cell.toLowerCase().replace(/ё/g, 'е').trim();
  if (PLACEHOLDER.test(cell)) return { enabled: false, minimum: false };
  const minimum = /минимум/.test(v);
  // «да — минимум», «да». Всё прочее — не «да»: непонятое значение не открывает гейт.
  //
  // Граница слова `\b` здесь не годится: в JS она считается по ASCII, и между «а» и
  // пробелом её нет — `/^да\b/` не совпадало ни с одной строкой набора, и вся пятёрка
  // молча числилась выключенной. Отсюда явное перечисление того, чем «да» кончается.
  const enabled = /^да(\s|[—–-]|$)/.test(v);
  return { enabled, minimum };
}

function parseReportsAt(cell: string): ReportsAt {
  const v = cell.toLowerCase().replace(/ё/g, 'е').trim();
  if (/вне\s+витка/.test(v)) return 'вне витка';
  const m = /этап\s*([1-7])/.exec(v);
  if (m === null) return null;
  return `этап ${m[1]}` as ReportsAt;
}

/**
 * Команда из колонки «Чем реализован».
 *
 * Командой считается только текст в обратных кавычках. Проза («скрипт сверки diff с
 * files_to_touch») — это описание того, чем гейт реализован, а не то, что можно
 * выполнить; попытка её исполнить дала бы `⏭` с бессмысленной диагностикой вместо
 * встроенной реализации.
 */
export function parseCommand(cell: string): string | null {
  // «н/п — долг» и просто «н/п». `\b` после кириллицы не срабатывает — см. parseEnabled.
  if (/^\s*н\/п(\s|[—–-]|$)/i.test(cell)) return null;
  if (PLACEHOLDER.test(cell) && !/`/.test(cell)) return null;
  const m = /`([^`]+)`/.exec(cell);
  if (m === null) return null;
  const cmd = m[1]!.trim();
  // Одиночное слово в кавычках чаще имя файла или артефакта, чем команда. Но глагол
  // с аргументами — команда. Различаем по наличию пробела, не угадывая дальше.
  return cmd === '' ? null : cmd;
}

export function parseGates(text: string): GatesFile {
  const rows: GateRow[] = [];
  for (const cells of tableRows(text, 'Набор')) {
    const name = (cells[0] ?? '').replace(/`/g, '').trim();
    if (name === '' || PLACEHOLDER.test(name)) continue;
    const { enabled, minimum } = parseEnabled(cells[1] ?? '');
    const implementation = cells[3] ?? '';
    rows.push({
      name,
      enabled,
      minimum,
      reportsAt: parseReportsAt(cells[2] ?? ''),
      implementation,
      command: parseCommand(implementation),
    });
  }

  const debt: DebtRow[] = [];
  for (const cells of tableRows(text, 'Долг')) {
    const name = (cells[0] ?? '').replace(/`/g, '').trim();
    if (name === '' || PLACEHOLDER.test(name)) continue;
    // «долг пуст» — принятая формой запись «строк нет», а не гейт с именем «долг пуст».
    if (/^долг\s+пуст$/i.test(name)) continue;
    const how = cells[2] ?? '';
    const date = cells[3] ?? '';
    const who = cells[4] ?? '';
    const problems: string[] = [];
    if (!/проверяет\s+руками|риск\s+принят/i.test(how)) {
      problems.push('не сказано, закрывается ручной проверкой или принятым риском');
    }
    if (!DATE.test(date)) problems.push('нет даты');
    if (!HAS_NAME.test(who) || PLACEHOLDER.test(who)) problems.push('нет имени');
    debt.push({
      name,
      where: cells[1] ?? '',
      how,
      date,
      who,
      closed: problems.length === 0,
      why: problems.join(', '),
    });
  }

  return { rows, debt };
}

/**
 * Проверка обязательного минимума. Возвращает список проблем — пустой список значит
 * «набор собран».
 *
 * У этих пяти строк переключателя нет: состояние без любой из них методология называет
 * «процесс не сконфигурирован», и виток при нём не стартует. Поэтому проверка стоит на
 * старте витка, а не на этапе 6 — иначе о несобранном наборе узнаёшь, потратив прогон.
 */
export function minimumProblems(g: GatesFile): string[] {
  const out: string[] = [];
  for (const name of MINIMUM) {
    const row = g.rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (row === undefined) {
      out.push(`в наборе нет обязательной строки «${name}»`);
      continue;
    }
    if (!row.enabled) {
      out.push(
        `обязательный гейт «${name}» выключен — у строк минимума переключателя нет, ` +
          `набор без неё не собран`,
      );
    }
  }
  return out;
}

/** Этапы, чьи гейты обязаны отчитаться в отчёте приёмки этапа 6. */
const REPORTED_AT_VERIFY: ReportsAt[] = ['этап 1', 'этап 2', 'этап 4', 'этап 5', 'этап 6'];

/**
 * Строки, которые обязаны быть в отчёте этапа 6.
 *
 * «Этап 7» сюда не входит: его этап ещё не наступил, и требовать его статус здесь
 * значило бы построить вердикт, который не может стать зелёным никогда. «Вне витка»
 * не входит по той же причине — место калибровки посевом между витками.
 */
export function gatesExpectedInReport(g: GatesFile): GateRow[] {
  return g.rows.filter((r) => r.enabled && REPORTED_AT_VERIFY.includes(r.reportsAt));
}

/** Гейты, которые рантайм прогоняет сам на этапе 6. Ранние этапы переносят статус. */
export function gatesRunnableAtVerify(g: GatesFile): GateRow[] {
  return g.rows.filter((r) => r.enabled && r.reportsAt === 'этап 6');
}

/**
 * Незакрытые строки долга.
 *
 * Считается и то, чего в таблице «Долг» нет вовсе: выключенный гейт без строки долга —
 * это ровно «никто не делает и никто не решал», случай, который методология называет
 * роняющим вердикт. Молчание закрытием не считается здесь ровно так же, как в решениях
 * человека.
 */
export function openDebt(g: GatesFile): string[] {
  const out: string[] = [];
  for (const row of g.debt) {
    if (!row.closed) out.push(`${row.name} (${row.why})`);
  }
  const named = new Set(g.debt.map((d) => d.name.toLowerCase()));
  for (const row of g.rows) {
    if (row.enabled) continue;
    if (named.has(row.name.toLowerCase())) continue;
    out.push(`${row.name} (гейт выключен, а строки в таблице «Долг» нет вовсе)`);
  }
  return out;
}

export { MINIMUM };
