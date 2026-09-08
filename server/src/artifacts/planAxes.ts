/**
 * Разбор секции «Последствия шагов» плана — гейт «Разбор последствий» (этап 4).
 *
 * Методология требует от секции трёх вещей, и все три механические:
 *
 *  - строка на КАЖДУЮ ось канона. Сокращённая таблица делает «этой оси здесь нет»
 *    неотличимым от «не подумали», а такое неразличение и есть подпись пачкой;
 *  - исход из ЗАКРЫТОГО словаря. Рекомендация, оставшаяся свободным текстом, не имеет
 *    исполнителя: `SDLC.md` → «Когда дефект проскочил» называет цену — три «усиления
 *    формулировки» на витках CV не оставили ни одного следа;
 *  - **у исхода существует адресат.** Это не украшение проверки, а вся разница между
 *    разбором и списком слов: без него шесть осей закрываются строками «claim-99»,
 *    «гейт „Такого нет“», «следующий виток» за один ход, и гейт зеленеет на словаре.
 *    Ревью поймало ровно это: `planAxisProblems` возвращала ноль проблем на плане, где
 *    ни одного адресата не существовало.
 *
 * Условия проверяются чтением артефактов, а не доверием к отчёту модели, — тем же
 * приёмом, что «карта разведки называет существующие пути» (`explorationPathProblem`).
 *
 * Разбор чистый, без I/O: факты об окружении (пункты задачи, строки набора, открытые
 * вопросы) приходят готовым `AxisContext` — собирает его `Run.axisProblems()`.
 */

import { columnIndex, headerKey, h2SectionRanges, parseTables } from '../md/table.ts';
import { placeholderRanges } from './artifact.ts';

/**
 * Канон осей. Список закрыт намеренно: правило двух задач работает только тогда, когда
 * у всех повторов одна и та же строка-класс — по той же причине, по которой «пять почему»
 * заменены закрытым списком причин. Проект дописывает свои оси строками сверх канона;
 * они разбираются наравне, но отсутствие канонической строки — дыра.
 */
export const AXES = [
  'Безопасность',
  'Ресурсы и скорость',
  'Отказы зависимостей',
  'Настройки',
  'Совместимость и данные',
  'Наблюдаемость',
] as const;

export type AxisName = (typeof AXES)[number];

/** Исход строки — закрытый словарь методологии. `unknown` — свободный текст. */
export type AxisOutcome =
  | 'claim'
  | 'invariant'
  | 'gate'
  | 'risk'
  | 'nextWitok'
  | 'notApplicable'
  | 'unknown';

export interface AxisRow {
  /** Имя оси как написано в плане. */
  name: string;
  /** Каноническое имя, если строка — про ось канона. */
  canonical: AxisName | null;
  /** `null` — ячейка не заполнена или не распознана. */
  affected: boolean | null;
  outcome: AxisOutcome;
  /** Ячейка исхода как есть — она же диагностика. */
  outcomeRaw: string;
  /** `claim-N`, названные в исходе: их существование проверяется по задаче. */
  claimIds: string[];
  /** Имя гейта из исхода (`гейт «Секреты в diff»`), если названо кавычками. */
  gateName: string | null;
}

/** Строка таблицы принятых рисков. Подписи в ней нет: риски принимаются одобрением плана. */
export interface AcceptedRisk {
  axis: string;
  why: string;
  /** «Когда вернуться» — принятый риск без срока пересмотра это забывание, а не решение. */
  revisit: string;
}

export interface PlanAxes {
  /** Секция «Последствия шагов» есть в плане вообще. */
  present: boolean;
  rows: AxisRow[];
  risks: AcceptedRisk[];
}

/**
 * Факты окружения, по которым проверяется существование адресата исхода.
 *
 * Пустой контекст (умолчание) отключает проверку адресатов, а не заваливает план: разбор
 * зовут и там, где задачи с набором рядом нет — например из теста по одному артефакту.
 */
export interface AxisContext {
  /** id пунктов приёмочного листа задачи. */
  claimIds?: readonly string[];
  /** Имена ВКЛЮЧЁННЫХ строк набора гейтов. */
  enabledGates?: readonly string[];
  /** В задаче есть незакрытый вопрос — адресат исхода «следующий виток». */
  hasOpenQuestion?: boolean;
  /** В задаче названы инварианты — адресат исхода «инвариант». */
  hasInvariants?: boolean;
}

/**
 * Нормализация ИМЕНИ оси — общим `headerKey`, а не своей копией.
 *
 * Копия отличалась одним: не снимала скобочный хвост, и ось «Безопасность (входные данные)»
 * переставала быть канонической — страж требовал строку, которая в плане была (ревью).
 */
function key(s: string): string {
  return headerKey(s.replace(/[_]/g, ''));
}

/**
 * Нормализация ЗНАЧЕНИЯ ячейки — своя, и намеренно НЕ `headerKey`.
 *
 * `headerKey` режет всё от первой открывающей скобки, потому что это правило для ключа
 * КОЛОНКИ («Как проверить (процедура + критерий)»). Применённое к данным, оно выбрасывало
 * содержимое: «н/п (новых настроек нет)» становилось голым «н/п» — претензия «без причины»
 * на ячейке, где причина написана, — а «(по итогам разведки) риск утечки» схлопывалось в
 * пустоту и читалось как «исход не из словаря» (ревью, обе формы воспроизведены).
 */
function cellKey(s: string): string {
  return s
    .replace(/[_`*]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

const CANONICAL = new Map<string, AxisName>(AXES.map((a) => [key(a), a]));

/**
 * Ячейка не заполнена: пусто либо незакрытое место формы.
 *
 * `placeholderRanges` — тот же разборщик, которым считают заполненность страж завершения и
 * `FinalizeArtifact`, вместе с его исключением инлайн-кода. Своя проверка `includes('‹')`
 * расходилась с ним: ячейка, цитирующая `‹…›` в обратных кавычках, была «готова» для
 * финализации и «пуста» для оси одновременно, и претензию нечем было закрыть (ревью).
 */
function blank(cell: string): boolean {
  return cell.trim() === '' || placeholderRanges(cell).length > 0;
}

/**
 * «Да/нет» из ячейки.
 *
 * Окончания перечисляются явно: `\b` в регулярках считает границу по ASCII и по кириллице
 * не работает вовсе (`CLAUDE.md` → «Особенности»). Ячейка, где остались оба варианта
 * («да / нет»), выбором не считается.
 */
function readAffected(cell: string): boolean | null {
  if (blank(cell)) return null;
  const t = cellKey(cell);
  const yes = /(^|[^а-я])да($|[^а-я])/.test(t);
  const no = /(^|[^а-я])нет($|[^а-я])/.test(t);
  if (yes === no) return null;
  return yes;
}

/**
 * Ключевые слова исходов. Побеждает то, что встретилось РАНЬШЕ по тексту ячейки, а не то,
 * что раньше проверено кодом: фиксированный порядок проверок читал «риск — см. claim-3»
 * как `claim`, «гейт „Секреты в diff“ — риск утечки закрыт» как `risk`, а «следующий
 * виток: оценить риск утечки» — тоже как `risk` (ревью, три ложных класса подряд).
 *
 * Окончания перечислены явно и здесь: «рискованно» и «рисковать» словом «риск» не
 * являются, иначе исходом становилась любая проза с оценкой.
 */
const OUTCOME_WORDS: readonly { re: RegExp; outcome: AxisOutcome }[] = [
  { re: /(^|[^а-я])н\s*\/\s*п/g, outcome: 'notApplicable' },
  { re: /claim-\d+/g, outcome: 'claim' },
  { re: /(^|[^а-я])инвариант(ы|а|ом|у|е)?($|[^а-я])/g, outcome: 'invariant' },
  { re: /(^|[^а-я])риск(и|а|ом|у|е|ов|ам)?($|[^а-я])/g, outcome: 'risk' },
  { re: /(^|[^а-я])следующ\S*\s+вит\S+/g, outcome: 'nextWitok' },
  { re: /(^|[^а-я])гейт\S*/g, outcome: 'gate' },
];

function readOutcome(cell: string): AxisOutcome {
  if (blank(cell)) return 'unknown';
  const t = cellKey(cell);
  let best: { at: number; outcome: AxisOutcome } | null = null;
  for (const { re, outcome } of OUTCOME_WORDS) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (m === null) continue;
    if (best === null || m.index < best.at) best = { at: m.index, outcome };
  }
  return best?.outcome ?? 'unknown';
}

/** Причина при `н/п`: то, что осталось после самой пометки. */
function hasReason(cell: string): boolean {
  return (
    cellKey(cell)
      .replace(/н\s*\/\s*п/, '')
      .replace(/[-—–:.,\s]/g, '') !== ''
  );
}

/** Имя гейта из исхода: `гейт «Секреты в diff»` → `Секреты в diff`. */
function gateNameOf(cell: string): string | null {
  const m = /(?:«([^»]+)»|"([^"]+)"|„([^“]+)“)/.exec(cell);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
}

function claimIdsOf(cell: string): string[] {
  return [...cell.matchAll(/claim-\d+/gi)].map((m) => m[0].toLowerCase());
}

/** Вид таблицы секции. Определяется по шапке, а при её потере — по строкам. */
type TableKind = 'axes' | 'risks';

function kindOfTable(header: readonly string[], rows: readonly (readonly string[])[]): TableKind {
  const keys = header.map((h) => key(h));
  if (keys.some((k) => k.startsWith('затронут') || k.startsWith('исход'))) return 'axes';
  if (keys.some((k) => k.startsWith('риск') || k.startsWith('когда вернут'))) return 'risks';
  // Шапка потеряна (виток из терминала, форму пишет модель) — узнаём по данным: у строки
  // оси вторая ячейка это «да/нет», у строки риска там проза. Прежний код опознавал только
  // таблицу осей, и подписанный риск разбирался как фантомная ось с тремя ложными
  // претензиями сразу (ревью).
  const all = [header, ...rows];
  const looksAxis = all.some((r) => readAffected(r[1] ?? '') !== null);
  return looksAxis ? 'axes' : 'risks';
}

function isHeaderRow(row: readonly string[]): boolean {
  const first = key(row[0] ?? '');
  return first === 'ось' || first.startsWith('ось ') || first === '';
}

export function parsePlanAxes(planText: string): PlanAxes {
  // Заголовок матчится ЦЕЛИКОМ, а не подстрокой: свободная `/последстви/i` затягивала в
  // разбор чужую секцию плана («## Последствия для клиентов»), и её строки становились
  // осями с двумя ложными претензиями каждая (ревью).
  const ranges = h2SectionRanges(planText, /^последстви\S*\s+шагов$/i);
  if (ranges.length === 0) return { present: false, rows: [], risks: [] };

  const rows: AxisRow[] = [];
  const risks: AcceptedRisk[] = [];

  for (const range of ranges) {
    for (const table of parseTables(planText.slice(range.start, range.end))) {
      const kind = kindOfTable(table.header, table.rows);
      // Шапка проверяется наравне со строками: модель, потерявшая строку-шапку, иначе
      // отдала бы первую строку данных под заголовок — тот же класс, что в карте разведки.
      const all = [table.header, ...table.rows].filter((r) => !isHeaderRow(r));

      if (kind === 'risks') {
        const why = columnIndex(table.header, 'почему');
        const revisit = columnIndex(table.header, 'когда');
        for (const row of all) {
          const axis = (row[0] ?? '').trim();
          if (axis === '') continue;
          risks.push({
            axis,
            why: (row[why >= 0 ? why : 2] ?? '').trim(),
            revisit: (row[revisit >= 0 ? revisit : 3] ?? '').trim(),
          });
        }
        continue;
      }

      // Колонки — по именам шапки; позиции остаются запасным вариантом на случай, когда
      // шапки нет вовсе. Прежний жёсткий `row[3]` читал исход из чужой ячейки, стоило
      // модели добавить колонку (ревью).
      const iAffected = columnIndex(table.header, 'затронут');
      const iOutcome = columnIndex(table.header, 'исход');
      for (const row of all) {
        const name = (row[0] ?? '').trim();
        if (name === '') continue;
        // Фолбэка «последняя ячейка строки» здесь нет намеренно. Он брал исход из колонки
        // «Что именно в шагах», стоило модели написать три ячейки вместо четырёх, — и
        // строка без колонки исхода проходила гейт ЗЕЛЁНОЙ, если в описании шага случайно
        // попадалось слово словаря («…включить гейт „Тесты“»). Отсутствующая ячейка обязана
        // читаться как отсутствующая: `unknown` и претензия про исход (ревью).
        const outcomeRaw = (row[iOutcome >= 0 ? iOutcome : 3] ?? '').trim();
        rows.push({
          name,
          canonical: CANONICAL.get(key(name)) ?? null,
          affected: readAffected(row[iAffected >= 0 ? iAffected : 1] ?? ''),
          outcome: readOutcome(outcomeRaw),
          outcomeRaw,
          claimIds: claimIdsOf(outcomeRaw),
          gateName: gateNameOf(outcomeRaw),
        });
      }
    }
  }

  return { present: true, rows, risks };
}

/**
 * Проблемы секции — строками, как их увидит оператор и модель.
 *
 * Пустой массив означает «разбор доведён», а не «оси не затронуты»: это разные вещи, и
 * вторая записывается исходом `н/п` с причиной.
 */
export function planAxisProblems(planText: string, ctx: AxisContext = {}): string[] {
  const parsed = parsePlanAxes(planText);
  if (!parsed.present) {
    return [
      'в плане нет секции «Последствия шагов», а гейт «Разбор последствий» включён в наборе — ' +
        'добавь секцию по шаблону плана: строка на каждую ось канона, у каждой исход из словаря',
    ];
  }

  const problems: string[] = [];
  const seen = new Map<AxisName, number>();
  for (const row of parsed.rows) {
    if (row.canonical === null) continue;
    seen.set(row.canonical, (seen.get(row.canonical) ?? 0) + 1);
  }

  const missing = AXES.filter((a) => !seen.has(a));
  if (missing.length > 0) {
    problems.push(
      `в «Последствиях шагов» нет строк для осей: ${missing.join(', ')} — ` +
        'таблица не сокращается, иначе «этой оси здесь нет» неотличимо от «не подумали»',
    );
  }
  // Дубль строки одной оси — тот же класс, что дубль строки набора гейтов: два ответа на
  // один вопрос неразличимы, и падение одного скрывается зелёным другого.
  for (const [axis, n] of seen) {
    if (n > 1) {
      problems.push(
        `ось «${axis}» разобрана ${n} раза — оставь одну строку: два ответа на один вопрос ` +
          'скрывают друг друга',
      );
    }
  }

  const riskAxes = new Set(parsed.risks.map((r) => key(r.axis)));
  const claims = new Set((ctx.claimIds ?? []).map((c) => c.toLowerCase()));
  const gates = new Set((ctx.enabledGates ?? []).map((g) => key(g)));

  for (const row of parsed.rows) {
    if (row.affected === null) {
      problems.push(
        `ось «${row.name}»: колонка «Затронута шагами» не заполнена — нужно «да» либо «нет»`,
      );
    }
    switch (row.outcome) {
      case 'unknown':
        problems.push(
          `ось «${row.name}»: исход не из словаря (${row.outcomeRaw === '' ? 'пусто' : row.outcomeRaw}) — ` +
            'нужен claim-N, инвариант, гейт «имя», риск, следующий виток либо «н/п — почему». ' +
            'Свободный текст исходом не является: у рекомендации нет исполнителя',
        );
        break;
      case 'notApplicable':
        if (!hasReason(row.outcomeRaw)) {
          problems.push(`ось «${row.name}»: «н/п» без причины — молчание решением не считается`);
        }
        if (row.affected === true) {
          problems.push(
            `ось «${row.name}»: объявлена затронутой, а исход «н/п» — затронутая ось ` +
              'закрывается решением, а не пометкой «не применимо»',
          );
        }
        break;
      case 'risk': {
        const risk = parsed.risks.find((r) => key(r.axis) === key(row.name));
        if (risk === undefined) {
          problems.push(
            `ось «${row.name}»: исход «риск», но строки с этой осью нет в таблице принятых ` +
              'рисков — риск без записи это «никто не делает и никто не решал»',
          );
        } else if (blank(risk.revisit)) {
          // Подписи в строке нет намеренно (риски принимаются полем «Одобрение» плана),
          // поэтому единственное, что отличает решение от забывания, — срок пересмотра.
          problems.push(
            `ось «${row.name}»: в строке принятого риска пусто «Когда вернуться» — ` +
              'принятый риск без срока пересмотра это не решение, а забывание',
          );
        } else if (blank(risk.why)) {
          problems.push(`ось «${row.name}»: в строке принятого риска не названа причина`);
        }
        break;
      }
      case 'claim': {
        if (ctx.claimIds === undefined) break;
        const unknownIds = row.claimIds.filter((id) => !claims.has(id));
        if (unknownIds.length > 0) {
          problems.push(
            `ось «${row.name}»: в задаче нет пунктов ${unknownIds.join(', ')} — ` +
              'пункт в приёмочный лист дописывает человек, и только после этого его id ' +
              'становится исходом. Ссылка на несуществующий пункт исходом не является',
          );
        }
        break;
      }
      case 'gate': {
        if (ctx.enabledGates === undefined) break;
        if (row.gateName === null) {
          problems.push(
            `ось «${row.name}»: исход «гейт», но имя гейта не названо в кавычках — ` +
              'сверка с набором идёт по имени дословно',
          );
        } else if (!gates.has(key(row.gateName))) {
          problems.push(
            `ось «${row.name}»: гейта «${row.gateName}» нет среди включённых строк набора — ` +
              'включение гейта это решение человека с записью в журнале набора, и оно ' +
              'делается до того, как гейт становится исходом',
          );
        }
        break;
      }
      case 'invariant': {
        if (ctx.hasInvariants === undefined) break;
        if (!ctx.hasInvariants) {
          problems.push(
            `ось «${row.name}»: исход «инвариант», но в задаче не назван ни один инвариант — ` +
              'инвариант живёт парой «утверждение + чем проверяется» в задаче, а не словом ' +
              'в клетке плана',
          );
        }
        break;
      }
      case 'nextWitok': {
        if (ctx.hasOpenQuestion === undefined) break;
        if (!ctx.hasOpenQuestion) {
          problems.push(
            `ось «${row.name}»: исход «следующий виток», но в задаче нет ни одного открытого ` +
              'вопроса — отложенное решение живёт записью в «Открытых вопросах», а не словами',
          );
        }
        break;
      }
      default:
        break;
    }
    if (row.affected === false && row.outcome !== 'notApplicable' && row.outcome !== 'unknown') {
      problems.push(
        `ось «${row.name}»: объявлена незатронутой, а исход — «${row.outcomeRaw}». ` +
          'Незатронутая ось закрывается «н/п — почему»; если решение всё-таки принято, ' +
          'колонка «Затронута шагами» должна говорить «да»',
      );
    }
  }

  // Риск, описанный строкой, но не названный ни одной осью, — след правки, при которой
  // исход поменяли, а строку забыли убрать: она читается как принятое решение, которым
  // никто не пользуется.
  for (const risk of parsed.risks) {
    if (risk.axis.trim() === '') continue;
    const named = parsed.rows.some(
      (r) => key(r.name) === key(risk.axis) && r.outcome === 'risk',
    );
    if (!named && !riskAxes.has(key(risk.axis))) continue;
    if (!named) {
      problems.push(
        `в таблице принятых рисков есть строка «${risk.axis}», но исход этой оси — не «риск»`,
      );
    }
  }

  return problems;
}
