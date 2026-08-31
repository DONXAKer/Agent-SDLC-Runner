/**
 * Сборка входа вердикта: набор гейтов + прогон рантайма + отчёт приёмки → `VerdictInput`.
 *
 * Здесь и только здесь встречаются два источника статуса: фактический прогон рантайма и
 * отчёт, который пишет модель. Расхождение между ними не сглаживается — в вердикт идёт
 * ХУДШИЙ из двух статусов, а само расхождение попадает в причины.
 *
 * Почему именно худший, а не «прогон всегда прав»: правило «побеждает прогон» защищало
 * от рецензента, перекрашивающего красное в зелёное, но работало и в обратную сторону —
 * рецензент ставил `❌`, найдя расхождение, а фиктивный «прогон» перебивал его зелёным.
 * Оба источника могут ошибаться в сторону зелёного и ни один — в сторону красного, и
 * только поэтому максимум по строгости безопасен.
 */

import type { ClaimStatus, GateRunResult, GateStatus, VerdictInput } from '@sdlc-runner/shared';
// Правило «худший статус побеждает» одно на всю кодовую базу: вторая его копия рядом
// означала бы, что вердикт и гейты могут разойтись в том, что считать зелёным.
import { worstClaimStatus, worstGateStatus } from '@sdlc-runner/shared';

import { hasPlaceholder, nameOnlyProblem } from '../artifacts/artifact.ts';
import { columnIndex, parseTables } from '../md/table.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { gateKey, gatesExpectedInReport, openDebt } from '../gates/gatesFile.ts';

const PLACEHOLDER = { test: (v: string): boolean => hasPlaceholder(v) };

function parseGateStatus(cell: string): GateStatus | null {
  if (PLACEHOLDER.test(cell)) return null;
  if (cell.includes('❌')) return '❌';
  if (cell.includes('⏭')) return '⏭';
  if (cell.includes('✅')) return '✅';
  return null;
}

function parseClaimStatus(cell: string): ClaimStatus | null {
  if (PLACEHOLDER.test(cell)) return null;
  if (cell.includes('❌')) return '❌';
  if (cell.includes('⚠')) return '⚠';
  if (cell.includes('✅')) return '✅';
  // Слово, а не значок: `manual` пишется словом и в шаблоне отчёта, и в таблице вердикта
  // методологии. Проверяется ПОСЛЕ значков — ячейка «✅ (manual уже не нужен)» означает
  // доказанный пункт, а не ручной.
  //
  // ВАЖНО: одного слова в отчёте мало. Освобождение от гейта даёт ТЕГ `[manual]` в
  // приёмочном листе задачи, который пишет человек; здесь только распознаётся заявка
  // рецензента, а подтверждается она в `collectVerdictInput` сверкой с этим списком.
  // Иначе слабый рецензент снимал бы пункт с проверки одним словом в собственном отчёте.
  if (/\bmanual\b/i.test(cell)) return 'manual';
  return null;
}

/**
 * Идентификатор пункта в канонической форме `claim-N`.
 *
 * Теги задачи (`[edge]`, `[manual]`) и обратные кавычки в ячейке — часть текста пункта, а не
 * его имени. Пока id брался ячейкой целиком, `claim-4 [edge]` и `claim-4` были РАЗНЫМИ
 * пунктами: свод по маршрутам ансамбля их не объединял, а сверка с планом не находила.
 * Тот же класс ошибки, что B1 ретро 2026-08-27 (регулярка не принимала строку с тегом).
 */
function claimId(cell: string): string {
  const raw = cell.replace(/`/g, '').trim();
  const m = /^(claim-\d+)\b/i.exec(raw);
  return m === null ? raw : m[1]!.toLowerCase();
}

/**
 * Значение пункта списка вида «- Метка: значение», ВКЛЮЧАЯ вложенный список под ним.
 *
 * Раньше брался только хвост той же строки, и самая естественная запись — когда находок
 * несколько и они идут вложенными пунктами — читалась как пустое значение. Главное
 * условие падения вердикта («любое подтверждённое расхождение из ревью») не срабатывало
 * ровно тогда, когда расхождений было больше одного.
 */
function bullet(report: string, label: RegExp): string | null {
  const lines = report.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t.startsWith('-') && !t.startsWith('*')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    if (!label.test(body)) continue;

    const colon = body.indexOf(':');
    const head = colon < 0 ? '' : body.slice(colon + 1).replace(/\*\*/g, '').trim();
    const indent = raw.length - raw.trimStart().length;

    const nested: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() === '') continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      const item = next.trim().replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      // Курсивная подсказка формы — часть шаблона, а не находка рецензента.
      if (item.startsWith('_')) continue;
      if (item !== '') nested.push(item);
    }

    if (nested.length === 0) return head;
    // В самой строке сказано «нет» — вложенное под ней является пояснением, а не
    // перечнем находок. Склейка превращала «- Расхождение: нет / - (проверены все
    // пункты)» в непустое значение и роняла вердикт по несуществующему расхождению.
    if (head !== '' && isEmptyValue(head)) return head;
    return head === '' ? nested.join('; ') : `${head}; ${nested.join('; ')}`;
  }
  return null;
}

/**
 * «н/п», «нет», «—» и плейсхолдер — это «пусто», а не содержимое.
 *
 * Сравнение по ПОЛНОМУ значению, а не по префиксу: пока стоял префикс, содержательная
 * находка, начинающаяся с тех же слов — «нет отката миграции при падении деплоя»,
 * «отсутствуют тесты на новый путь ошибки», — выбрасывалась вместе с настоящими
 * заглушками, и красный вердикт становился зелёным.
 *
 * Но и голое равенство слишком узко: человек пишет не «н/п», а «н/п — не применимо» и
 * «нет (все пункты закрыты)». Поэтому перед сверкой отрезается пояснительный хвост —
 * то, что идёт ПОСЛЕ разделителя (тире, скобка, двоеточие, запятая). Разделитель здесь
 * и есть различитель: «нет отката миграции» — сплошная фраза без него и остаётся
 * находкой, «нет — всё закрыто» распадается на маркер и пояснение.
 */
const EMPTY_VALUES = new Set([
  'н/п',
  'нет',
  'нету',
  '—',
  '–',
  '-',
  'отсутствуют',
  'отсутствует',
  'не выявлено',
  'не выявлены',
  'не обнаружено',
  'нет замечаний',
  // Формы, которыми рецензенты пишут «находок нет» в разделах регрессий и инвариантов.
  // Без них доказательство ОТСУТСТВИЯ регрессии числилось находкой (r35).
  'нет регрессий',
  'регрессий нет',
  'нет откатов',
  'реализация верна',
]);

/** Маркер пустоты с отрезанным пояснительным хвостом: «нет — всё закрыто» → «нет». */
function emptyMarker(t: string): string {
  const cut = t.split(/\s[—–-]\s|\s*[(:,]/u)[0] ?? t;
  return cut.replace(/[.;,]+$/, '').trim();
}

function isEmptyValue(v: string | null): boolean {
  if (v === null) return true;
  const t = v.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.;,]+$/, '').trim();
  if (t === '') return true;
  if (PLACEHOLDER.test(v)) return true;
  return EMPTY_VALUES.has(t) || EMPTY_VALUES.has(emptyMarker(t));
}

export interface ReportFacts {
  gateStatuses: Map<string, GateStatus>;
  inapplicable: Map<string, string>;
  claims: { id: string; status: ClaimStatus }[];
  confirmedReviewFindings: number;
  brokenInvariants: string[];
  regressions: string[];
  plannedPathsUntouched: string[];
  diffMatchesTree: boolean;
}

/**
 * Запоминает подписанную строку неприменимости.
 *
 * Планка — имя, и только имя: форма методологии держит в этой колонке `‹имя›` и говорит
 * дословно «колонка "Утвердил" без имени = артефакт не заполнен». Требование даты, которое
 * тут стояло, форма не предъявляет — оно блокировало снятие `⏭` на отчёте, заполненном
 * строго по шаблону эталона. Плейсхолдер и пустота именем по-прежнему не считаются: это
 * тот самый путь, которым красный вердикт становится зелёным, и слабее он быть не может.
 */
function rememberInapplicable(into: Map<string, string>, name: string, who: string): void {
  if (name === '' || PLACEHOLDER.test(name)) return;
  if (nameOnlyProblem(who) !== null) return;
  into.set(gateKey(name), who.trim());
}

export function readReport(report: string): ReportFacts {
  const tables = parseTables(report);

  const gateStatuses = new Map<string, GateStatus>();
  const inapplicable = new Map<string, string>();
  const claims: { id: string; status: ClaimStatus }[] = [];

  for (const t of tables) {
    const gateCol = columnIndex(t.header, 'гейт');
    const statusCol = columnIndex(t.header, 'статус');
    const signedCol = columnIndex(t.header, 'утвердил');
    const idCol = columnIndex(t.header, 'id');

    // Порядок веток значим: СНАЧАЛА статусы. Пока первой стояла неприменимость, таблица
    // естественной формы «Гейт | Статус | Утвердил» целиком уходила в неё и делала
    // continue: все статусы терялись, каждый включённый гейт попадал в «не отчитался»,
    // и вердикт краснел без единой настоящей причины.
    if (gateCol >= 0 && statusCol >= 0) {
      for (const row of t.rows) {
        const name = row[gateCol] ?? '';
        if (name === '' || PLACEHOLDER.test(name)) continue;
        const st = parseGateStatus(row[statusCol] ?? '');
        // Строка есть, а статуса в ней нет — это не «прошёл». Гейт со стёртым статусом
        // получает `⏭` и роняет вердикт, как и не запускавшийся.
        gateStatuses.set(gateKey(name), st ?? '⏭');

        // Подпись неприменимости может стоять в той же таблице — читаем её здесь же.
        if (signedCol >= 0) rememberInapplicable(inapplicable, name, row[signedCol] ?? '');
      }
      continue;
    }

    // Отдельная таблица неприменимости: имя гейта + кто подписал, колонки «Статус» нет.
    if (gateCol >= 0 && signedCol >= 0) {
      for (const row of t.rows) {
        rememberInapplicable(inapplicable, row[gateCol] ?? '', row[signedCol] ?? '');
      }
      continue;
    }

    if (idCol >= 0) {
      const passedCol = columnIndex(t.header, 'passed');
      for (const row of t.rows) {
        const id = claimId(row[idCol] ?? '');
        if (id === '' || PLACEHOLDER.test(id)) continue;
        const st = passedCol >= 0 ? parseClaimStatus(row[passedCol] ?? '') : null;
        // Пункт без статуса — доказательства нет. Это `⚠`, а не пропуск строки.
        claims.push({ id, status: st ?? '⚠' });
      }
    }
  }

  const listAfter = (heading: RegExp, label: RegExp): string[] => {
    const v = bullet(sectionText(report, heading), label);
    return isEmptyValue(v) ? [] : [v!.trim()];
  };

  const reviewFindings = listAfter(/^2\./, /Подтверждённое расхождение/i);

  const invariants: string[] = [];
  for (const line of sectionText(report, /^4\./).split(/\r?\n/)) {
    const m = /нарушен:\s*(.+)$/i.exec(line);
    // Фильтр пустых значений — тот же, что у регрессий ниже: без него «нарушен: нет»
    // и «нарушен: нет (реализация верна)» становились НАРУШЕННЫМИ инвариантами и роняли
    // вердикт (r35, coder-next заполнил так все четыре строки раздела).
    if (m !== null && !PLACEHOLDER.test(m[1]!) && !isEmptyValue(m[1]!)) invariants.push(m[1]!.trim());
  }

  const regressions: string[] = [];
  for (const line of sectionText(report, /^5\./).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('-') && !t.startsWith('*')) continue;
    const body = t.replace(/^[-*]\s*/, '');
    if (isEmptyValue(body)) continue;
    if (/^_/.test(body)) continue; // курсивная подсказка формы
    // Строка, которая САМА себя объявляет зелёной и не содержит ни одного признака
    // отката, — это доказательство отсутствия регрессии, а не находка. Рецензенты
    // заполняют так весь раздел («Сборка проходит: … — ✅», «тесты не тронуты: ✅»),
    // и каждая такая строка роняла вердикт как регрессия (r35).
    if (/[✅✓]/.test(body) && !/[❌✗]|упал|падает|сломан|откат|regress/iu.test(body)) continue;
    regressions.push(body);
  }

  // «не сделано» — красный вердикт. «не потребовалось, потому что X» — правка плана,
  // и сюда не попадает: различие несёт формулировка, и молчание не годится ни в одну
  // из сторон.
  const untouched: string[] = [];
  for (const line of sectionText(report, /^3\./).split(/\r?\n/)) {
    if (!/«?не сделано»?/i.test(line)) continue;
    if (PLACEHOLDER.test(line)) continue;
    const path = /^[\s-*]*[`«]?([^`»—-]+)/.exec(line.trim())?.[1]?.trim() ?? line.trim();
    untouched.push(path);
  }

  const sync = bullet(report, /Сверка с деревом/i);
  // Утверждение «совпал» должно быть сказано. Отсутствие строки — не «да».
  const diffMatchesTree =
    sync !== null &&
    !PLACEHOLDER.test(sync) &&
    /(^|[\s:*(])да([\s.,;)]|$)/i.test(sync) &&
    !/(^|[\s:*(])нет([\s.,;)—–-]|$)/i.test(sync);

  return {
    gateStatuses,
    inapplicable,
    claims,
    confirmedReviewFindings: reviewFindings.length,
    brokenInvariants: invariants,
    regressions,
    plannedPathsUntouched: untouched,
    diffMatchesTree,
  };
}

/** Текст секции от её заголовка до следующего заголовка того же или высшего уровня. */
function sectionText(report: string, title: RegExp): string {
  const lines = report.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  let level = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h !== null) {
      const l = h[1]!.length;
      if (inside && l <= level) break;
      if (!inside && title.test(h[2]!.trim())) {
        inside = true;
        level = l;
        continue;
      }
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

export interface CollectInput {
  gates: GatesFile;
  /** Что рантайм прогнал сам на этом этапе. */
  gateResults: readonly GateRunResult[];
  /**
   * Гейты (ключами `gateKey`), чей зелёный статус рантайм знает достовернее отчёта.
   *
   * Ровно один случай на сегодня: «Ревью независимым агентом». Рантайм видел фактический
   * вызов субагента — это факт, а не мнение, и `⏭` в отчёте («не запускался») его
   * опровергнуть не может, потому что запускался. Красный отчёта при этом всё равно
   * побеждает: рецензент, нашедший дефект, — не тот источник, который стоит переспоривать.
   */
  runtimeAuthoritativeWhenGreen?: readonly string[];
  /**
   * Факт рантайма: совпал ли патч попытки с фактическим деревом. `undefined`/`null` —
   * сверки не было, и тогда действует прежнее правило «сказано в отчёте».
   *
   * Зачем факт вообще: условие «артефакт этапа 5 устарел» роняет вердикт, а держалось
   * оно на фразе «Сверка с деревом: да» в отчёте модели. Серия r31 — три сэмпла подряд
   * с кодом 9/9 покраснели только потому, что слабый рецензент не написал этого слова.
   */
  diffMatchesTreeFact?: boolean | null;
  /**
   * Пункты приёмки, помеченные в ЗАДАЧЕ тегом `[manual]` — id в канонической форме.
   *
   * Источник освобождения от автоматической проверки — приёмочный лист человека, а не
   * отчёт рецензента. Пока список не передавался, `manual` в ячейке отчёта принимался на
   * веру, и слабая модель могла снять любой пункт с проверки одним словом. Пусто —
   * ручных пунктов в задаче нет, и любое «manual» в отчёте становится `⚠`.
   */
  manualClaims?: readonly string[];
  /**
   * Отчёты приёмки этой попытки — по одному на маршрут ансамбля.
   *
   * Список, а не строка: маршрутов этапа 6 может быть несколько, и раньше все они писали
   * в один файл, а вердикт читал его один раз — то есть побеждал последний записавший, и
   * слабый рецензент стирал `❌` сильного. Свод по худшему статусу здесь и делает «`✅`
   * только если так сказали все» свойством вердикта, а не примечанием в исполнителе.
   *
   * Пустой список либо пустые тексты — отчёта нет.
   */
  reports: readonly string[];
  attempt: number;
  attemptBudget: number;
  noProgress: boolean;
}

export interface CollectResult {
  input: VerdictInput;
  /** Гейты, где отчёт и прогон разошлись. Побеждает ХУДШИЙ из двух статусов. */
  disagreements: string[];
  /**
   * Замечания к КАЧЕСТВУ ОТЧЁТА: рецензент вписал красный там, где рантайм своими руками
   * получил зелёный. Вердикт от этого не краснеет (факт прогона авторитетнее), но
   * молчать нельзя — это характеристика рецензента, и оператор обязан её видеть.
   */
  reportQuality: string[];
}

/**
 * Свод фактов нескольких отчётов приёмки в один — по худшему статусу.
 *
 * Правило то же, что и везде: `✅` только если так сказали ВСЕ рецензенты. Поэтому
 * статусы берутся худшие, а списки найденного (сломанные инварианты, регрессии,
 * нетронутые пути плана) объединяются: дефект, увиденный одним, остаётся дефектом,
 * сколько бы других его ни пропустило.
 *
 * `inapplicable` — исключение из объединения: подпись под неприменимостью снимает `⏭`,
 * то есть ослабляет вердикт. Её достаточно от одного рецензента только потому, что сама
 * строка неприменимости подписана ИМЕНЕМ человека, а не мнением модели.
 */
function mergeFacts(list: readonly ReportFacts[]): ReportFacts {
  const first = list[0];
  if (first === undefined) return readReport('');
  if (list.length === 1) return first;

  const gateStatuses = new Map<string, GateStatus>();
  const inapplicable = new Map<string, string>();
  const claims = new Map<string, ClaimStatus>();
  const claimOrder: string[] = [];
  let confirmedReviewFindings = 0;
  const brokenInvariants = new Set<string>();
  const regressions = new Set<string>();
  const plannedPathsUntouched = new Set<string>();
  let diffMatchesTree = true;

  for (const f of list) {
    for (const [key, status] of f.gateStatuses) {
      const prev = gateStatuses.get(key);
      gateStatuses.set(key, prev === undefined ? status : worstGateStatus(prev, status));
    }
    for (const [key, who] of f.inapplicable) if (!inapplicable.has(key)) inapplicable.set(key, who);
    for (const c of f.claims) {
      const prev = claims.get(c.id);
      if (prev === undefined) claimOrder.push(c.id);
      claims.set(c.id, prev === undefined ? c.status : worstClaimStatus(prev, c.status));
    }
    // Находки ревью суммируются, а не берутся максимумом: два рецензента, нашедшие по
    // одному подтверждённому дефекту, нашли два дефекта.
    confirmedReviewFindings += f.confirmedReviewFindings;
    for (const x of f.brokenInvariants) brokenInvariants.add(x);
    for (const x of f.regressions) regressions.add(x);
    for (const x of f.plannedPathsUntouched) plannedPathsUntouched.add(x);
    if (!f.diffMatchesTree) diffMatchesTree = false;
  }

  return {
    gateStatuses,
    inapplicable,
    claims: claimOrder.map((id) => ({ id, status: claims.get(id) ?? '❌' })),
    confirmedReviewFindings,
    brokenInvariants: [...brokenInvariants],
    regressions: [...regressions],
    plannedPathsUntouched: [...plannedPathsUntouched],
    diffMatchesTree,
  };
}

/** Id пунктов с тегом `[manual]` из приёмочного листа задачи. */
export function manualClaimIds(intentText: string): string[] {
  const out: string[] = [];
  // Строка таблицы приёмки: `| claim-3 [manual] | … |`. Тег ищется в той же ячейке, где
  // стоит id, — тег в тексте пункта («проверяется manual-прогоном») освобождением не
  // является, иначе формулировка пункта становилась бы способом снять его с проверки.
  const row = /^\|([^|]+)\|/gm;
  let m: RegExpExecArray | null;
  while ((m = row.exec(intentText)) !== null) {
    const cell = (m[1] ?? '').replace(/`/g, '').trim();
    if (!/\[manual\]/i.test(cell)) continue;
    const id = /^(claim-\d+)\b/i.exec(cell);
    if (id !== null) out.push(id[1]!.toLowerCase());
  }
  return out;
}

export function collectVerdictInput(i: CollectInput): CollectResult {
  const facts = mergeFacts(i.reports.map(readReport));
  // Заявка рецензента на `manual` подтверждается тегом в задаче. Не подтверждена —
  // становится `⚠`: «доказательство держится на непройденной проверке», что и есть правда.
  const manual = new Set(i.manualClaims ?? []);
  const expected = gatesExpectedInReport(i.gates);
  const byRun = new Map(i.gateResults.map((r) => [gateKey(r.name), r]));

  const gates: VerdictInput['gates'] = [];
  const missing: string[] = [];
  const disagreements: string[] = [];
  const reportQuality: string[] = [];

  for (const row of expected) {
    const key = gateKey(row.name);
    const run = byRun.get(key);
    const reported = facts.gateStatuses.get(key);

    if (reported === undefined) {
      missing.push(row.name);
      // Строки в отчёте нет — но и молча пропустить гейт нельзя: если рантайм его
      // прогнал, статус известен и обязан участвовать в вердикте.
      if (run !== undefined) {
        gates.push({
          name: row.name,
          status: run.status,
          inapplicableSignedBy: facts.inapplicable.get(key) ?? null,
          envBlocked: run.envBlocked,
        });
      }
      continue;
    }

    // Гейт, который рантайм ИСПОЛНИЛ САМ (команда или встроенная реализация — у обеих
    // есть код возврата) и получил зелёный, отчётом не опровергается. Живой прогон r23:
    // все девять гейтов фактически зелёные, а рецензент вписал в таблицу
    // «Scope: файлы вне плана ❌ — файл snapshot.json вне плана», списав это из отчёта
    // ПРЕДЫДУЩЕЙ попытки, лежавшего рядом в артефактах; «худший из двух» honestly взял
    // ❌ — и виток, у которого сошлось всё, остался красным по выдумке.
    //
    // Ослаблением защиты это не является: правило существует против ЛОЖНОГО ЗЕЛЁНОГО
    // («модель может ошибиться в статусе, но не может выдать зелёный за красный»), а тут
    // рантайм своими руками получил код возврата 0. Настоящие находки рецензента роняют
    // вердикт по другим каналам — расхождения, пункты приёмки, регрессии, инварианты, —
    // и подделанный зелёный ловит отдельный гейт «Анти-обход тест-гейта».
    const runtimeExecutedGreen = run !== undefined && run.status === '✅' && run.exitCode !== null;
    const authoritative =
      run !== undefined &&
      run.status === '✅' &&
      (runtimeExecutedGreen ||
        (reported === '⏭' && (i.runtimeAuthoritativeWhenGreen ?? []).includes(key)));

    const status = run === undefined ? reported : authoritative ? '✅' : worstGateStatus(run.status, reported);
    // `authoritative` — ШТАТНЫЙ, ожидаемый случай, а не спор источников: прогон гейтов
    // идёт ДО ревью, поэтому «не запускался» в отчёте слабой модели — норма, а не признак
    // того, что рецензент переписывает статусы. Пока он попадал сюда, классификатор
    // причин красного видел непустой `disagreements` и объявлял «отчёт рецензента разошёлся
    // с фактическим прогоном» на самом частом сценарии — сигнал недоверия на ровном месте.
    if (run !== undefined && run.status !== reported && !authoritative) {
      disagreements.push(
        `гейт «${row.name}»: в отчёте ${reported}, фактический прогон дал ${run.status} — ` +
          `в вердикт идёт худший из двух (${status})`,
      );
    }
    // Отчёт разошёлся с прогоном, но прогон авторитетен — вердикт не роняем, а качество
    // отчёта называем: это замечание к рецензенту, а не к работе исполнителя.
    if (run !== undefined && run.status !== reported && authoritative && runtimeExecutedGreen) {
      reportQuality.push(
        `гейт «${row.name}»: рецензент вписал ${reported}, хотя фактический прогон дал ✅ ` +
          `(${run.command ?? 'встроенная реализация'}, код ${run.exitCode}) — в вердикт идёт факт`,
      );
    }
    gates.push({
      name: row.name,
      status,
      inapplicableSignedBy: facts.inapplicable.get(key) ?? null,
      // Признак берётся у ПРОГОНА, а не у отчёта: рецензент о причине отказа среды знать
      // не обязан, а рантайм её видел сам.
      envBlocked: run?.envBlocked ?? false,
    });
  }

  if (
    i.diffMatchesTreeFact !== undefined &&
    i.diffMatchesTreeFact !== null &&
    i.diffMatchesTreeFact !== facts.diffMatchesTree
  ) {
    reportQuality.push(
      i.diffMatchesTreeFact
        ? 'сверка с деревом: рецензент не подтвердил совпадение патча, но рантайм сверил сам — патч совпадает'
        : 'сверка с деревом: рецензент заявил совпадение, но рантайм сверил сам — патч устарел',
    );
  }

  return {
    disagreements,
    reportQuality,
    input: {
      gates,
      // Заявленный рецензентом `manual` действителен только для пунктов, помеченных
      // человеком в задаче. Неподтверждённая заявка понижается до `⚠` — не «почти да»,
      // а честное «доказательство держится на непройденной проверке».
      claims: facts.claims.map((c) =>
        c.status === 'manual' && !manual.has(c.id) ? { ...c, status: '⚠' as const } : c,
      ),
      confirmedReviewFindings: facts.confirmedReviewFindings,
      enabledGatesMissingFromReport: missing,
      openDebtRows: openDebt(i.gates),
      brokenInvariants: facts.brokenInvariants,
      regressions: facts.regressions,
      plannedPathsUntouched: facts.plannedPathsUntouched,
      // Факт рантайма побеждает прозу отчёта в ОБЕ стороны: он получен той же командой,
      // которой снимался патч, и спорить с ним рецензенту нечем.
      diffMatchesTree: i.diffMatchesTreeFact ?? facts.diffMatchesTree,
      attempt: i.attempt,
      attemptBudget: i.attemptBudget,
      noProgress: i.noProgress,
    },
  };
}
