/**
 * Выжимка причин красного вердикта — вход следующей попытки chunk'а.
 *
 * Без неё повторная попытка получала тот же промпт, что и первая: модель заново читала
 * задачу, план и diff и заново угадывала, что именно не понравилось, — при том что причины
 * уже посчитаны и лежат рядом. Это самый дешёвый рычаг сокращения числа итераций: данные
 * собраны, транспорт (`extra` → `buildPrompt`) написан, недоставало сборки текста.
 *
 * Функция чистая и без I/O — как и всё в `verdict/`: её вход целиком определяет её выход,
 * поэтому она проверяется таблицей, а не прогоном витка.
 *
 * Здесь ПЕРЕЧЕНЬ ФАКТОВ, а не инструкция. «Упал гейт X, вывод такой» — факт; «исправь X
 * так-то» — уже решение, которое принимает исполнитель, глядя на код. Фразы рецензента
 * («что чинить» из записи пункта, находки §2–§5) приходят как его слова — с подписью, чьи
 * они, а не как вывод рантайма.
 *
 * Что здесь было и чего не хватало (разбор 2026-09-02): бриф называл пункт только по id
 * («claim-2 — опровергнут»), при том что `intent.md` во входах chunk'а нет; из гейта —
 * одну последнюю строку, из ревью — ЧИСЛО расхождений; `what_to_fix` из записей
 * рецензента собирался и не рендерился. Ретрай получал 80 КБ прошлых патчей и ни одного
 * текста находки. `RetryDetail` — как раз эти тексты, все уже посчитанные рантаймом.
 */

import type { GateRunResult, VerdictInput } from '@sdlc-runner/shared';

/** Сколько строк хвоста вывода упавшего гейта берётся в бриф. */
const GATE_TAIL_LINES = 12;

/**
 * Кадр стека, ведущий не в код проекта, а во внутренности рантайма или в зависимости.
 *
 * Замерено на реальном отказе (`bench`, `perf-keep-behavior`, 2026-09-05): у `node --test`
 * блок провалов печатается последним — то есть хвост берётся в правильном месте, — но при
 * ДВУХ упавших тестах он занимает 21 строку, из которых 8 суть кадры `node:internal/...`.
 * В окно 12 строк попадал только ВТОРОЙ провал плюс обрывки стека первого, и повторная
 * попытка чинила половину проблемы, не зная о второй. Модель три попытки подряд не
 * починила регрессию, видя ровно это.
 *
 * Выбрасываются только кадры, которые ничего не сообщают о правке: место падения в коде
 * проекта (`at … file:///…/src/stock.ts:155`) под шаблон не подпадает и остаётся.
 */
const INTERNAL_FRAME_RE = /^\s*at\s+(?:async\s+)?\S.*\((?:node:|internal\/)|^\s*at\s+(?:async\s+)?(?:node:|internal\/)|node_modules/;

/**
 * Собственная «визитка» `node --test` после ЛЮБОГО провала: 8 строк счётчиков
 * (`ℹ tests/suites/pass/fail/…`) и повторный блок «✖ failing tests:» / `test at
 * файл:N:N` / `✖ файл (Nms)` / `'test failed'` — по 3-4 строки на каждый упавший файл.
 * Она не несёт диагноза и сама по себе съедает `GATE_TAIL_LINES` раньше настоящей
 * причины — та же болезнь, что у `INTERNAL_FRAME_RE`, другой источник переполнения.
 *
 * Найдено на двух независимых прогонах 2026-09-25 (`d2-devstral-vat-rounding`,
 * `s3-ministral3-vat-rounding`): три попытки подряд, оба разных модели, окно ретрая
 * состояло ЦЕЛИКОМ из этой визитки — ни слова о `SyntaxError`, из-за которого их
 * собственный новый тестовый файл не грузится. Рецензент (полный доступ к артефактам,
 * не к брифу) каждый раз называл точную строку падения верно; модель на повторной
 * попытке не видела её вовсе. Вероятный корень класса #13
 * (`docs/model-error-taxonomy.md`) — «свой тест невалиден при верном коде»: открыт по
 * 5+ случаям на 3+ моделях, и все известные — под `node --test`.
 *
 * Счётчики (`ℹ …`) — визитка безусловно, в живом выводе `node --test` их не бывает.
 * Но `✖ <имя> (Nms)`/`test at …`/`'test failed'` печатаются ДВАЖДЫ: один раз сразу за
 * причиной провала (живой вывод — если у теста говорящее имя, это может быть
 * ЕДИНСТВЕННОЕ место с содержательным текстом, например при `assert.fail()` без
 * сообщения), второй раз — в итоговом «✖ failing tests:» (recap, буквальный повтор).
 * Резать нужно только повтор: безусловное совпадение любого `✖ … (Nms)` стирало бы и
 * единственный содержательный экземпляр (code-review-all, 2026-09-26).
 * `stripNodeTestBoilerplate` поэтому стейтфул — режет `✖ …`/`test at …`/`'test failed'`
 * только ПОСЛЕ строки-маркера recap-блока, живой (первый) экземпляр остаётся.
 *
 * Тот же формат вывода разбирает `exec/StepExecutor.ts::FAILURE_LOCATION_RES` — с ДРУГОЙ
 * задачей (куда роутить ремонт шага, не что обрезать в брифе), поэтому это не общий код, а
 * два независимых набора регулярок. Правишь формат распознавания здесь — проверь тот файл.
 */
const NODE_TEST_COUNTER_RE =
  /^\s*ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|start of coverage report|end of coverage report)\b/;
const NODE_TEST_RECAP_HEADER_RE = /^\s*✖ failing tests:\s*$/;
const NODE_TEST_RECAP_LINE_RE = /^\s*test at .+:\d+:\d+\s*$|^\s*✖ .+\(\d+(\.\d+)?ms\)\s*$|^\s*'test failed'\s*$/;

function stripNodeTestBoilerplate(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inRecap = false;
  for (const l of lines) {
    if (NODE_TEST_RECAP_HEADER_RE.test(l)) {
      inRecap = true;
      continue;
    }
    if (NODE_TEST_COUNTER_RE.test(l)) continue;
    if (inRecap && NODE_TEST_RECAP_LINE_RE.test(l)) continue;
    out.push(l);
  }
  return out;
}

/** Сколько находок ревью показывается — дальше это уже отчёт, а не выжимка. */
const FINDINGS_MAX = 8;

export interface RetryDetail {
  /** Текст пункта приёмки по id (как в приёмочном листе задачи) — дословно. */
  claimTexts?: ReadonlyMap<string, string>;
  /** «Что чинить» из записи рецензента по id пункта — его слова. */
  whatToFix?: ReadonlyMap<string, string>;
  /** Находки ревью §2–§5: суть и место. `anchored` — ссылка на место нашлась в патче. */
  findings?: readonly { text: string; evidence: string; anchored: boolean }[];
  /**
   * `retry_instruction` рецензента — одна строка «что чинить в первую очередь». Считалась
   * (`reviewJson.ts`) и не подавалась: gpt-oss-20b три попытки подряд не тронул `sku !== ''`,
   * дважды сделав правку old==new ровно на этом пункте (rename-field, 2026-09-25).
   */
  retryInstruction?: string;
}

/**
 * Текст пункта приёмки из строки листа — сама формулировка, без служебных колонок.
 *
 * Строка таблицы `| claim-1 | текст | тег | процедура | статус |` уходила в бриф целиком,
 * ~600 символов на пункт; семь таких строк в карточке шага режутся потолком 12 КБ раньше
 * находок рецензента с адресом `файл:строка` — то есть самого ценного (bench, stepfill-v2).
 * Берётся первая ячейка после id; строка списка — текст после id и разделителя.
 */
export function claimTextCell(line: string): string {
  const t = line.trim();
  if (t.startsWith('|')) {
    const cells = t
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const idx = cells.findIndex((c) => /^`?claim-[\w-]+`?(\s*\[[^\]]*\])?$/iu.test(c));
    const text = idx >= 0 ? cells[idx + 1] : cells[1];
    return text === undefined || text === '' ? t : text;
  }
  const m = /^(?:[-*]|\d+[.)])?\s*`?claim-[\w-]+`?\s*[—:–-]?\s*(.+)$/iu.exec(t);
  return m === null || m[1] === undefined ? t : m[1].trim();
}

/** Пустая строка вывода — это «вывода не было», а не «причина неизвестна». */
function lastLineOf(g: GateRunResult): string {
  return g.lastLine.trim() === '' ? 'вывод пуст' : g.lastLine.trim();
}

/**
 * Хвост вывода гейта, когда он есть: имена упавших тестов и трейсбек живут именно там, а
 * из одной последней строки («2 failing») диагноз не следует.
 */
function gateLines(g: GateRunResult): string[] {
  const how = g.command ?? 'без команды';
  const code = g.exitCode === null ? '' : `, код ${g.exitCode}`;
  const head = `- «${g.name}» (${how}${code}): ${lastLineOf(g)}`;
  const lines = (g.outputTail ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    // Внутренние кадры и собственная визитка `node --test` выбрасываются ДО среза: иначе
    // они съедают окно, и в бриф попадает последний провал вместо всех — или, у визитки,
    // не попадает НИ ОДИН (см. INTERNAL_FRAME_RE, stripNodeTestBoilerplate).
    .filter((l) => !INTERNAL_FRAME_RE.test(l));
  const tail = stripNodeTestBoilerplate(lines).slice(-GATE_TAIL_LINES);
  if (tail.length === 0) return [head];
  // Четыре кавычки, как у `fence` в prompt/build.ts: хвост тестов, сравнивающих markdown,
  // сам содержит тройные, и ограждение из трёх ломало разметку остатка брифа.
  return [head, '  ````', ...tail.map((l) => `  ${l}`), '  ````'];
}

function claimLine(
  c: VerdictInput['claims'][number],
  detail: RetryDetail | undefined,
): string[] {
  const status =
    c.status === '❌' ? 'опровергнут (❌)' : 'не проверяем (⚠): доказательство держится на непройденной проверке';
  const text = detail?.claimTexts?.get(c.id.toLowerCase());
  const fix = detail?.whatToFix?.get(c.id.toLowerCase());
  const out = [`- ${c.id} — ${status}${text === undefined ? '' : `: ${text}`}`];
  if (fix !== undefined && fix.trim() !== '' && !/^н\/п$/i.test(fix.trim())) {
    out.push(`  по словам рецензента, чинить: ${fix.trim()}`);
  }
  return out;
}

/**
 * Собирает блок «что не сошлось» по входу вердикта и фактическому прогону гейтов.
 *
 * `null` — сказать нечего: вердикт красным не был или ни одной называемой причины не
 * нашлось. Пустой блок в промпт не уходит: раздел без содержимого читается как «претензий
 * нет», а это не то же самое, что «претензии не собрались».
 */
export function buildRetryBrief(
  input: VerdictInput,
  gateResults: readonly GateRunResult[],
  detail?: RetryDetail,
): string | null {
  const sections: string[] = [];

  // Первой строкой — потому что это единственное место брифа, где рецензент назвал
  // приоритет; ниже идут факты без порядка важности.
  const instruction = detail?.retryInstruction?.trim() ?? '';
  if (instruction !== '' && !/^н\/п$/i.test(instruction)) {
    sections.push(`Рецензент: в первую очередь — ${instruction}`);
  }

  const failedClaims = input.claims.filter((c) => c.status !== '✅' && c.status !== 'manual');
  if (failedClaims.length > 0) {
    sections.push(
      'Пункты приёмки, которые не закрыты:',
      ...failedClaims.flatMap((c) => claimLine(c, detail)),
    );
  }

  // Статусы берём из фактического прогона, а не из отчёта: отчёт мог их переписать, и в
  // вердикт всё равно шёл худший из двух.
  const failedGates = gateResults.filter((g) => g.status === '❌');
  if (failedGates.length > 0) {
    sections.push('Гейты, которые упали:', ...failedGates.flatMap(gateLines));
  }

  const unsignedSkips = input.gates.filter(
    (g) =>
      g.status === '⏭' &&
      (g.inapplicableSignedBy === null || g.inapplicableSignedBy.trim() === ''),
  );
  if (unsignedSkips.length > 0) {
    sections.push(
      'Гейты, которые включены, но не запускались (строки неприменимости с именем нет):',
      ...unsignedSkips.map((g) => `- «${g.name}»`),
    );
  }

  if (input.confirmedReviewFindings > 0) {
    sections.push(
      `Подтверждённых расхождений из ревью: ${input.confirmedReviewFindings}. Каждое роняет ` +
        'вердикт само по себе, даже если пункта приёмки на это поведение нет.',
    );
  }

  // Тексты находок — после числа: число считает вердикт, тексты — слова рецензента.
  // Находки с привязкой к месту идут первыми: у них есть адрес, по которому чинить.
  const findings = [...(detail?.findings ?? [])]
    .filter((f) => f.text.trim() !== '')
    .sort((a, b) => Number(b.anchored) - Number(a.anchored))
    .slice(0, FINDINGS_MAX);
  if (findings.length > 0) {
    sections.push(
      'Находки ревью (слова рецензента; место — как он его назвал):',
      ...findings.map(
        (f) =>
          `- ${f.text.trim()}` +
          (f.evidence.trim() === '' ? '' : ` — ${f.evidence.trim()}`) +
          (f.anchored ? '' : ' _(место в патче не найдено)_'),
      ),
    );
  }

  const lists: [string, readonly string[]][] = [
    ['Нарушенные инварианты:', input.brokenInvariants],
    ['Регрессии:', input.regressions],
    ['Файлы плана, которых правка не коснулась:', input.plannedPathsUntouched],
    ['Открытые строки долга:', input.openDebtRows],
    ['Включённые гейты, не отчитавшиеся в отчёте:', input.enabledGatesMissingFromReport],
  ];
  for (const [title, items] of lists) {
    if (items.length > 0) sections.push(title, ...items.map((v) => `- ${v}`));
  }

  if (!input.diffMatchesTree) {
    sections.push(
      'Diff в отчёте разошёлся с деревом: проверялось не то, что лежит в рабочем каталоге.',
    );
  }

  if (input.noProgress) {
    sections.push(
      'Прогресса нет: патч этой попытки совпал с предыдущим. Повтор того же изменения ' +
        'ничего не даст — нужно другое.',
    );
  }

  if (sections.length === 0) return null;

  return [
    '## Что не сошлось в прошлой попытке',
    '',
    'Ниже — факты прошлого прогона, посчитанные рантаймом, и отдельной подписанной',
    'строкой под пунктом — слова рецензента там, где они есть. Рецензент тоже может',
    'ошибиться в диагнозе — сверь его слова с кодом сам, прежде чем чинить по ним: из',
    'последней строки вывода гейта диагноз ошибки не следует.',
    '',
    ...sections,
  ].join('\n');
}
