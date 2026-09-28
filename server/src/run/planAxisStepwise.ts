/**
 * Пошаговый добор осей плана: одна степень свободы на вопрос.
 *
 * Комбинированный топ-ап (`planAxisFill.ts`) просит слабую модель выдать за один ответ
 * строку из 3–6 полей на каждую из шести осей — и живой замер показал, что словарь исходов
 * снял класс «не тот ключ», но не класс «строка из N колонок одним ответом»: `test29`
 * (2026-09-23, `gpt-oss-20b-axisfill`) — топ-ап состоялся технически и не дал ни одной
 * разобранной клетки; `test27`/`test28` — «—», пусто, «н/п» без причины у всех моделей,
 * дошедших до этапа 4. Здесь та же таблица собирается ПОСЛЕДОВАТЕЛЬНОСТЬЮ узких вопросов,
 * каждый — про одно поле одного вида:
 *
 *  1. по всем осям — «затронута шагами?»: строки `N. да` / `N. нет`;
 *  2. по незатронутым — одна строка причины на ось (`N. причина`) → `н/п — причина`;
 *  3. по затронутым — одна строка «что именно в шагах» на ось (`N. файл:символ — что`);
 *  4. по каждой затронутой — исход РОВНО одним ключом из перечисленных КОНКРЕТНЫХ адресатов
 *     (`claim-3`, `гейт «Тесты»`, …) — закрытый выбор, как у `choice`-поля бланка;
 *  5. по каждой оси с исходом «риск» — три подписанные строки риска.
 *
 * Строку таблицы собирает рантайм (`AxisFillAnswer`) и пишет тем же `applyAxisAnswers`, что
 * и комбинированный добор: второго формата записи в план не появляется. Адресат исхода
 * проверяется ЗДЕСЬ, по тем же фактам, что `planAxisProblems` (`AxisContext`): ключ не из
 * списка доступных адресатов ответом не считается, и ось остаётся открытой для стража —
 * вместо того чтобы в план уходила строка, которую страж сам же и отвергнет.
 *
 * Каждый вопрос — свежий запрос `system + user` без истории (тот же приём, что карточка поля
 * `FormFillExecutor`): бюджет ответа задаётся конструкцией вопроса, а не дисциплиной модели.
 * Цена — до `3 + 2·(затронутых осей)` запросов вместо одного; на локальной модели это минуты,
 * но этап, который прежде вставал на этой таблице целиком, минуты стоит.
 */

import type { Usage } from '@sdlc-runner/shared';

import { AFFIRMATIVE_HEAD, axisHint } from './reviewFill.ts';
import { matchAxisOutcome, type AxisOutcomeKey } from './axisOutcomes.ts';
import {
  NEGATIVE,
  NOT_APPLICABLE_HEAD,
  askPlanAxes,
  planAxisContext,
  planAxisContextLines,
  stripAnswerWrappers,
  type PlanAxisFillInput,
  type PlanAxisFillResult,
} from './planAxisFill.ts';
import { annotateExchange } from '../provider/rawLog.ts';
import { axisRowOf, axisRowProblems, type AxisName } from '../artifacts/planAxes.ts';
import type { AxisFillAnswer } from '../artifacts/renderAxes.ts';

const askOnce = askPlanAxes;

/**
 * Вопрос шага: сначала общий для всех шагов контекст (шаги плана, опоры разведки), потом
 * то, что меняется от шага к шагу. Порядок ради префиксного кэша локального движка: до 15
 * вопросов подряд делят `system` и план, и переменный заголовок ПЕРЕД планом заставлял
 * движок заново перерабатывать весь план на каждом вопросе (code-review-all 2026-09-23).
 */
function stepQuestion(i: PlanAxisFillInput, tail: readonly string[]): string {
  return [...planAxisContextLines(i), '', ...tail].join('\n');
}

function axisList(axes: readonly AxisName[]): string[] {
  return axes.map((a, idx) => `${idx + 1}. Ось «${a}» — ${axisHint(a)}`);
}

// ── вопросы ────────────────────────────────────────────────────────────────

export function affectedQuestion(i: PlanAxisFillInput): string {
  return stepQuestion(i, [
    `## Разбор последствий, шаг 1 из 4: какие оси затрагивают шаги плана`,
    '',
    '## Оси',
    '',
    ...axisList(i.axes),
    '',
    `Ответь РОВНО ${i.axes.length} строками, по одной на ось, В ТОМ ЖЕ ПОРЯДКЕ: \`N. да\` либо \`N. нет\`.`,
    'Ось затронута, если хотя бы один шаг плана меняет то, что перечислено в её подсказке.',
    'Ничего, кроме этих строк, не пиши.',
  ]);
}

export function reasonsQuestion(i: PlanAxisFillInput, axes: readonly AxisName[]): string {
  return stepQuestion(i, [
    `## Разбор последствий, шаг 2 из 4: почему ось не затронута`,
    '',
    '## Оси, которые шаги плана НЕ затрагивают',
    '',
    ...axisList(axes),
    '',
    `Ответь РОВНО ${axes.length} строками, по одной на ось, В ТОМ ЖЕ ПОРЯДКЕ: \`N. причина\` — одно`,
    'предложение, ПОЧЕМУ шаги плана эту ось не трогают (что именно в шагах этого не делает).',
    'Пример: `2. метрик и логов шаги не добавляют, вывод не меняется`.',
    'Ничего, кроме этих строк, не пиши.',
  ]);
}

export function whatQuestion(i: PlanAxisFillInput, axes: readonly AxisName[]): string {
  return stepQuestion(i, [
    `## Разбор последствий, шаг 3 из 4: что именно в шагах затрагивает ось`,
    '',
    '## Оси, которые шаги плана затрагивают',
    '',
    ...axisList(axes),
    '',
    `Ответь РОВНО ${axes.length} строками, по одной на ось, В ТОМ ЖЕ ПОРЯДКЕ: \`N. файл:символ — что меняется\`.`,
    'Называй только файлы и символы из шагов плана выше. Пример: `1. src/config.ts:loadLimits — читает лимит из process.env`.',
    'Ничего, кроме этих строк, не пиши.',
  ]);
}

/** Конкретные адресаты исхода — только те, что реально существуют в задаче и наборе. */
export interface OutcomeOption {
  key: AxisOutcomeKey;
  /** Текст ячейки «Исход», который уйдёт в план. */
  cell: string;
  /** Строка списка в вопросе. */
  line: string;
}

export function outcomeOptions(i: PlanAxisFillInput): OutcomeOption[] {
  const out: OutcomeOption[] = [];
  for (const id of i.claimIds) {
    out.push({ key: 'claim-N', cell: id, line: `- \`${id}\` — пункт ${id} приёмочного листа уже проверяет это` });
  }
  if (i.hasInvariants) out.push({ key: 'инвариант', cell: 'инвариант', line: '- `инвариант` — это держит инвариант, названный в задаче' });
  for (const g of i.enabledGates) {
    out.push({ key: 'гейт', cell: `гейт «${g}»`, line: `- \`гейт «${g}»\` — это проверяет включённый гейт набора «${g}»` });
  }
  if (i.hasOpenQuestion) {
    out.push({ key: 'следующий виток', cell: 'следующий виток', line: '- `следующий виток` — решение уходит в открытый вопрос задачи' });
  }
  out.push({ key: 'риск', cell: 'риск', line: '- `риск` — риск принимается осознанно (причину и срок пересмотра спрошу отдельно)' });
  return out;
}

export function outcomeQuestion(i: PlanAxisFillInput, axis: AxisName, what: string, options: readonly OutcomeOption[]): string {
  return stepQuestion(i, [
    `## Разбор последствий, шаг 4 из 4: исход по оси «${axis}»`,
    '',
    `Ось «${axis}» (${axisHint(axis)}) затронута шагами плана: ${what}`,
    '',
    'Кто закрывает это последствие? Выбери РОВНО один пункт из списка и ответь ОДНОЙ строкой —',
    'ключом дословно, как он записан в списке:',
    '',
    ...options.map((o) => o.line),
    '',
    'Другие исходы не существуют: пункта, гейта или инварианта, которых нет в списке, в задаче нет.',
    'Ничего, кроме одной строки с ключом, не пиши.',
  ]);
}

export function riskQuestion(i: PlanAxisFillInput, axis: AxisName, what: string): string {
  return stepQuestion(i, [
    `## Разбор последствий: принятый риск по оси «${axis}»`,
    '',
    `Ось «${axis}» затронута шагами плана (${what}), исход — риск принимается.`,
    '',
    'Ответь РОВНО тремя подписанными строками:',
    '',
    'что: ‹что именно может пойти не так›',
    'почему допустимо: ‹почему это допустимо сейчас›',
    'когда вернуться: ‹событие или срок пересмотра›',
    '',
    'Ничего, кроме этих трёх строк, не пиши.',
  ]);
}

// ── разбор ─────────────────────────────────────────────────────────────────

const stripWrappers = stripAnswerWrappers;

/** Ведущий маркер списка или номер строки (`- `, `* `, `1. `, `2) `) — не часть ответа. */
function stripLead(line: string): string {
  return line.trim().replace(/^(?:[-*•]\s+|\d+\s*[.):]\s*)/, '');
}

/**
 * «Не затронута» / «не затрагивается» — естественный ответ на вопрос «затронута?», и
 * голова `^нет` его не видела: ось молча выпадала из добора (code-review-all 2026-09-23).
 */
const NOT_AFFECTED = /^не\s+(?:затрон|затраг|касает|меня)/i;

/**
 * Строки `N. текст` (также `N)` и `N:`), номер — порядок в вопросе с 1. При повторе номера
 * побеждает ПОСЛЕДНЯЯ строка: самокоррекция модели отзывает первую версию (тот же довод,
 * что у поблочного разбора комбинированного ответа). Номер вне диапазона пропускается.
 */
export function parseNumberedLines(count: number, answer: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    const m = /^(\d+)\s*[.):]\s*(.*)$/.exec(line);
    if (m === null) continue;
    const idx = Number(m[1]) - 1;
    const text = stripWrappers(m[2] ?? '');
    if (idx < 0 || idx >= count || text === '') continue;
    out.set(idx, text);
  }
  return out;
}

/** «да»/«нет» по осям; `н/п` в ответе читается как «нет» (тот же класс, что в комбинированном разборе). */
export function parseAffected(count: number, answer: string): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const [idx, text] of parseNumberedLines(count, answer)) {
    if (AFFIRMATIVE_HEAD.test(text)) out.set(idx, true);
    else if (NEGATIVE.test(text) || NOT_APPLICABLE_HEAD.test(text) || NOT_AFFECTED.test(text)) out.set(idx, false);
  }
  return out;
}

/**
 * Один ключ из перечисленных адресатов. Берётся ПЕРВАЯ содержательная строка ответа;
 * ключ сопоставляется словарём (`matchAxisOutcome`), а адресат — списком: `claim-9` при
 * пунктах 1–4 или гейт не из набора ответом не считаются. `н/п` для затронутой оси —
 * тоже не ответ: затронутая ось закрывается решением, а не пометкой.
 */
export function parseOutcomeChoice(answer: string, options: readonly OutcomeOption[]): OutcomeOption | null {
  // Кавычки внутри строки не снимаются: по ним читается имя гейта. Снимается только
  // разметка по краям, не `«»` — хвостовая `»` уносила закрывающую кавычку имени.
  const line = answer
    .split(/\r?\n/)
    .map((l) => stripLead(l).replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, ''))
    .find((l) => l !== '' && !l.startsWith('```'));
  if (line === undefined) return null;
  // Отрицание («не риск, а claim-1») — не выбор ключа: отрицаемое слово из разбора
  // убирается, иначе первым находился отвергнутый моделью ключ.
  const m = matchAxisOutcome(line.replace(/(^|[^а-яё])не\s+[^\s,.;]+/gi, '$1'));
  if (m === null) return null;
  switch (m.key) {
    case 'claim-N': {
      const id = /claim-\d+/i.exec(line)?.[0].toLowerCase();
      return options.find((o) => o.key === 'claim-N' && o.cell.toLowerCase() === id) ?? null;
    }
    case 'гейт': {
      // Имя гейта — ДОСЛОВНО, в кавычках или сразу после слова «гейт». Поиск имени
      // подстрокой подменял несуществующий гейт существующим («Тесты на граничные
      // значения» → «Тесты»), а «гейт не из набора ответом не считается» (докстринг выше).
      const quoted = /[«"“„]([^»"”“]+)[»"”“]/.exec(line)?.[1];
      const bare = /гейт\S*\s+(.+)$/i.exec(line)?.[1];
      const name = (quoted ?? bare ?? '').trim().toLowerCase();
      if (name === '') return null;
      return options.find((o) => o.key === 'гейт' && o.cell.toLowerCase() === `гейт «${name}»`) ?? null;
    }
    case 'инвариант':
    case 'следующий виток':
    case 'риск':
      return options.find((o) => o.key === m.key) ?? null;
    case 'н/п':
      return null;
  }
}

/** Три подписанные строки риска; порядковые `1./2./3.` — запасная форма. Любое пустое поле — не ответ. */
export function parseRiskFields(answer: string): { what: string; why: string; revisit: string } | null {
  const fields: Record<'what' | 'why' | 'revisit', string> = { what: '', why: '', revisit: '' };
  // Подписи — и в той форме, что показана в вопросе, и в той, что подсказывает его
  // плейсхолдер («почему это допустимо сейчас»); номер строки перед подписью снимается,
  // иначе значения уходили в таблицу рисков вместе с подписями (code-review-all 2026-09-23).
  const labels: { re: RegExp; field: keyof typeof fields }[] = [
    { re: /^(?:что(?:\s+(?:именно\s+)?может\s+пойти\s+не\s+так)?|what)\s*:\s*(.+)$/i, field: 'what' },
    { re: /^(?:почему(?:\s+(?:это\s+)?допустимо)?(?:\s+сейчас)?|why)\s*:\s*(.+)$/i, field: 'why' },
    { re: /^(?:когда(?:\s+вернуться)?|revisit|when)\s*:\s*(.+)$/i, field: 'revisit' },
  ];
  for (const raw of answer.split(/\r?\n/)) {
    const line = stripWrappers(stripLead(raw).replace(/^\*\*([^*]+)\*\*/, '$1'));
    for (const { re, field } of labels) {
      const m = re.exec(line);
      if (m !== null) fields[field] = stripWrappers(m[1] ?? '');
    }
  }
  if (fields.what === '' || fields.why === '' || fields.revisit === '') {
    const numbered = parseNumberedLines(3, answer);
    fields.what = fields.what || (numbered.get(0) ?? '');
    fields.why = fields.why || (numbered.get(1) ?? '');
    fields.revisit = fields.revisit || (numbered.get(2) ?? '');
  }
  if (fields.what === '' || fields.why === '' || fields.revisit === '') return null;
  return fields;
}

// ── конвейер ───────────────────────────────────────────────────────────────

/** См. докстринг модуля. Тот же контракт, что у `fillPlanAxes`. */
export async function fillPlanAxesStepwise(i: PlanAxisFillInput): Promise<PlanAxisFillResult> {
  const answers: AxisFillAnswer[] = [];
  if (i.axes.length === 0) return { answers, envFailure: null };
  const note = (s: string): void => i.onProgress?.(s);
  const ctx = planAxisContext(i);
  /**
   * Строка уходит в план, только если её прочтёт читатель плана — тот же `axisRowProblems`,
   * что у комбинированного добора: «н/п — —», «‹почему›» из бланка и прочее, что страж
   * отвергнет, ответом не считается, и ось остаётся открытой (code-review-all 2026-09-23).
   */
  const accept = (a: AxisFillAnswer): void => {
    const problems = axisRowProblems(axisRowOf(a.axis, a.affectedText, a.outcome), ctx);
    if (problems.length === 0) answers.push(a);
    else note(`ось «${a.axis}» не записана: ${problems[0]}`);
  };
  // Отмена этапа: провайдер бросает обычную ошибку, и без этой проверки добор спрашивал
  // бы дальше, а вызывающий — просил бы одобрить запись уже после отмены.
  const cancelled = (): PlanAxisFillResult | null => (i.signal.aborted ? { answers: [], envFailure: null } : null);
  // Мишень корпуса `planAxisFill` (`docs/model-tuning.md`) — та же, что у комбинированного
  // добора (`planAxisFill.ts::fillPlanAxes`), но здесь на КАЖДЫЙ из пяти шагов свой обмен:
  // до этой правки ни один из них не размечался (code-review-all, 2026-09-27). Оракул тот
  // же контракт «ровно N строк», отдельное имя — чтобы не путать со сплошным разбором
  // комбинированной формы при анализе корпуса.
  const labelStep = (rawLogPath: string | null, accepted: boolean, reason: string): void => {
    annotateExchange(rawLogPath, {
      accepted,
      oracle: 'plan-axis-parse-step',
      target: 'plan-axis-fill',
      reason: accepted ? 'accepted' : reason,
    });
  };

  // Шаг 1: затронута?
  const r1 = await askOnce(i, affectedQuestion(i));
  const stop1 = cancelled();
  if (stop1 !== null) return stop1;
  if ('env' in r1) return { answers, envFailure: r1.env };
  if ('failed' in r1) {
    note(`оси плана не отвечены: ${r1.failed}`);
    return { answers, envFailure: null };
  }
  const affected = parseAffected(i.axes.length, r1.text);
  labelStep(r1.rawLogPath, affected.size === i.axes.length, `affected-answered-${affected.size}-of-${i.axes.length}`);
  if (affected.size < i.axes.length) note(`шаг «затронута?»: разобрано ${affected.size} из ${i.axes.length}`);
  const yes = i.axes.filter((_, idx) => affected.get(idx) === true);
  const no = i.axes.filter((_, idx) => affected.get(idx) === false);

  // Шаг 2: причины для незатронутых — одной строкой на ось.
  if (no.length > 0) {
    const r2 = await askOnce(i, reasonsQuestion(i, no));
    const stop2 = cancelled();
    if (stop2 !== null) return stop2;
    if ('env' in r2) return { answers, envFailure: r2.env };
    if ('failed' in r2) note(`шаг «почему не затронута»: ${r2.failed}`);
    else {
      const reasons = parseNumberedLines(no.length, r2.text);
      labelStep(r2.rawLogPath, reasons.size === no.length, `reasons-answered-${reasons.size}-of-${no.length}`);
      for (const [idx, reason] of reasons) {
        const axis = no[idx]!;
        accept({ axis, affectedText: 'нет', what: `— / ${reason}`, outcome: `н/п — ${reason}` });
      }
      if (reasons.size < no.length) note(`шаг «почему не затронута»: разобрано ${reasons.size} из ${no.length}`);
    }
  }

  if (yes.length === 0) return { answers, envFailure: null };

  // Шаг 3: что именно — одной строкой на затронутую ось.
  const r3 = await askOnce(i, whatQuestion(i, yes));
  const stop3 = cancelled();
  if (stop3 !== null) return stop3;
  if ('env' in r3) return { answers, envFailure: r3.env };
  if ('failed' in r3) {
    note(`шаг «что именно в шагах»: ${r3.failed}`);
    return { answers, envFailure: null };
  }
  const whats = parseNumberedLines(yes.length, r3.text);
  labelStep(r3.rawLogPath, whats.size === yes.length, `what-answered-${whats.size}-of-${yes.length}`);
  if (whats.size < yes.length) note(`шаг «что именно в шагах»: разобрано ${whats.size} из ${yes.length}`);

  // Шаг 4: исход — по одной оси, одним ключом из конкретных адресатов.
  const options = outcomeOptions(i);
  for (const [idx, axis] of yes.entries()) {
    const what = whats.get(idx);
    if (what === undefined) continue;
    const r4 = await askOnce(i, outcomeQuestion(i, axis, what, options));
    const stop4 = cancelled();
    if (stop4 !== null) return stop4;
    if ('env' in r4) return { answers, envFailure: r4.env };
    if ('failed' in r4) {
      note(`исход оси «${axis}»: ${r4.failed}`);
      continue;
    }
    const choice = parseOutcomeChoice(r4.text, options);
    labelStep(r4.rawLogPath, choice !== null, 'outcome-not-in-list');
    if (choice === null) {
      note(`исход оси «${axis}» не из списка адресатов: «${r4.text.trim().split('\n')[0] ?? ''}»`);
      continue;
    }
    if (choice.key !== 'риск') {
      accept({ axis, affectedText: 'да', what, outcome: choice.cell });
      continue;
    }
    // Шаг 5: три поля принятого риска.
    const r5 = await askOnce(i, riskQuestion(i, axis, what));
    const stop5 = cancelled();
    if (stop5 !== null) return stop5;
    if ('env' in r5) return { answers, envFailure: r5.env };
    if ('failed' in r5) {
      note(`риск по оси «${axis}»: ${r5.failed}`);
      continue;
    }
    const risk = parseRiskFields(r5.text);
    labelStep(r5.rawLogPath, risk !== null, 'risk-fields-incomplete');
    if (risk === null) {
      note(`риск по оси «${axis}»: три поля не разобраны`);
      continue;
    }
    accept({ axis, affectedText: 'да', what, outcome: 'риск', risk });
  }

  return { answers, envFailure: null };
}
