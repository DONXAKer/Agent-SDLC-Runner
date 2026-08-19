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

import { hasPlaceholder, signatureProblem } from '../artifacts/artifact.ts';
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
// Плейсхолдер и подпись человека — общие определения на весь рантайм: пока копий было
// четыре, они разошлись, и одна и та же ячейка считалась заполненной здесь и пустой в
// разборе отчёта приёмки.
const PLACEHOLDER = { test: (v: string): boolean => hasPlaceholder(v) };

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
  // «да — минимум», «да», «да.», «да, минимум», «да (минимум)». Всё прочее — не «да»:
  // непонятое значение не открывает гейт.
  //
  // Граница слова `\b` здесь не годится: в JS она считается по ASCII, и между «а» и
  // пробелом её нет — `/^да\b/` не совпадало ни с одной строкой набора, и вся пятёрка
  // молча числилась выключенной. Перечисляем окончания явно, включая знаки препинания:
  // «да.» — обычная запись человека, а стоила она отказа стартовать весь виток.
  const enabled = /^да([\s.,;:—–()-]|$)/.test(v);
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
  const m = /`([^`]+)`/.exec(cell);
  if (m === null) return null;

  const cmd = m[1]!.trim();
  // Ячейка целиком в форме («‹чем; пути `.sdlc/**` исключены›») команды не содержит.
  if (cmd === '' || hasPlaceholder(cell)) return null;

  // Ячейка, которая ВСЯ состоит из одного фрагмента в кавычках, — это команда, чем бы она
  // ни выглядела. Иначе эвристика ниже отвергала самые обычные записи набора — `make`,
  // `pytest`, `tox`, `npm test` пишутся именно так, — и обязательный гейт уходил во
  // встроенную реализацию мимо того, чем проект реально собирается.
  if (cell.replace(/`[^`]+`/, '').trim() === '') return cmd;

  // Ячейка «Чем реализован» держит и команду, и прозу с процитированными именами:
  // эталонный набор методологии пишет «скрипт сверки diff с `files_to_touch`», шаблон —
  // «‹чем; пути `.sdlc/**` из сверки исключены›». Пока командой считался первый попавшийся
  // текст в кавычках, рантайм запускал `files_to_touch`, получал «command not found» и
  // красил обязательный scope-гейт в ❌ на каждом витке, ни разу не вызвав встроенную
  // реализацию. Команда — это глагол с аргументами либо явный путь к исполняемому файлу;
  // одиночное имя без пробела и без пути командой не считается.
  //
  // Путь ГДЕ-ТО внутри фрагмента (не только в начале) раньше тоже считался признаком
  // команды — «изменения в `backend/src/test/**` сверяются с планом» распознавалось как
  // вызов `backend/src/test/**` и падало с «is a directory». Ссылка на путь в прозе —
  // не то же самое, что явный вызов исполняемого файла: у последнего путь стоит в начале
  // фрагмента (`./mvnw`, `~/tools/x`, `/usr/bin/x`), а не где-то в середине цитаты.
  const looksLikeCommand = /\s/.test(cmd) || /^[.~/]/.test(cmd);
  return looksLikeCommand ? cmd : null;
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
    // Подпись закрытия долга считается тем же предикатом, что и подпись решения человека
    // в артефакте и подпись неприменимости в отчёте: планка у них обязана быть одна.
    const signature = signatureProblem(`${who} ${date}`);
    if (signature !== null) problems.push(signature);
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
    const row = g.rows.find((r) => gateKey(r.name) === gateKey(name));
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

/**
 * Ключ гейта: имя строки, приведённое к сравнимому виду.
 *
 * Одно правило на весь рантайм. Их было четыре в четырёх файлах (где-то регистр, где-то
 * ещё и «ё», где-то точное совпадение), и строка, прошедшая проверку минимума, могла
 * промахнуться мимо диспетчеризации: гейт получал `⏭` «исполнить нечем» и ронял вердикт
 * по несуществующей причине.
 */
export function gateKey(name: string): string {
  return name.replace(/`/g, '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Всё, из-за чего набор нельзя считать сконфигурированным.
 *
 * Кроме минимальной пятёрки сюда входят две вещи, которые раньше проходили молча и
 * стоили дороже: нераспознанная колонка «Где отчитывается» (гейт исчезал и из прогона,
 * и из вердикта — виток зеленел с фактически отключённым гейтом минимума) и две строки
 * с одинаковым именем (их статусы схлопывались в один, и `❌` одной затирался другой).
 */
export function configProblems(g: GatesFile): string[] {
  const out = minimumProblems(g);

  for (const row of g.rows) {
    if (!row.enabled) continue;
    if (row.reportsAt === null) {
      out.push(
        `у включённого гейта «${row.name}» не распознана колонка «Где отчитывается»: ` +
          `значение не похоже ни на «этап N», ни на «вне витка». Такой гейт не ` +
          `прогоняется и не участвует в вердикте — это молчаливое отключение.`,
      );
      continue;
    }
    // Распознанный, но никем не собираемый этап — то же молчаливое отключение, только
    // незаметнее. Отчёт этапа 6 собирает этапы 1/2/4/5/6; «этап 7» отчитывается в
    // handoff'е, «вне витка» — своими артефактами. Всё прочее (например «этап 3», где
    // артефакта со статусами гейтов нет вовсе) не спросит никто.
    if (!REPORTED_AT_VERIFY.includes(row.reportsAt) && !NOT_REPORTED_AT_VERIFY.includes(row.reportsAt)) {
      out.push(
        `включённый гейт «${row.name}» отчитывается на «${row.reportsAt}» — этого статуса ` +
          `не спрашивает ни отчёт приёмки, ни handoff. Гейт не участвует в вердикте ни на ` +
          `одном этапе: перенеси его на этап 1/2/4/5/6, на этап 7 или «вне витка».`,
      );
    }
  }

  const seen = new Map<string, string>();
  for (const row of g.rows) {
    const key = gateKey(row.name);
    const first = seen.get(key);
    if (first !== undefined) {
      out.push(
        `в наборе две строки с одним именем: «${first}» и «${row.name}» — статусы таких ` +
          `строк неразличимы, и падение одной скрывается зелёным другой`,
      );
      continue;
    }
    seen.set(key, row.name);
  }

  return out;
}

/** Этапы, чьи гейты обязаны отчитаться в отчёте приёмки этапа 6. */
const REPORTED_AT_VERIFY: ReportsAt[] = ['этап 1', 'этап 2', 'этап 4', 'этап 5', 'этап 6'];

/** Где статус спрашивают не в отчёте этапа 6, но всё-таки спрашивают. */
const NOT_REPORTED_AT_VERIFY: ReportsAt[] = ['этап 7', 'вне витка'];

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
  // Сверка имён — тем же ключом, что и везде: `toLowerCase()` не приводит «ё», обратные
  // кавычки и двойные пробелы, и строка долга «Секреты в diff'е» не находилась к гейту
  // «Секреты в diff'е » — закрытый долг числился открытым и ронял вердикт.
  const named = new Set(g.debt.map((d) => gateKey(d.name)));
  for (const row of g.rows) {
    if (row.enabled) continue;
    if (named.has(gateKey(row.name))) continue;
    out.push(`${row.name} (гейт выключен, а строки в таблице «Долг» нет вовсе)`);
  }
  return out;
}

export { MINIMUM };
