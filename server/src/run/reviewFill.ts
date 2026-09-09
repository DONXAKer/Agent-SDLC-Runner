/**
 * Этап 6 по хункам: закрытые вопросы рантайма вместо одного свободного хода рецензента.
 *
 * Зачем. Рецензент этапа 6 получает system 16 КБ + задачу, план, набор и diff (до 40 КБ
 * каждый), 60 ходов и Read/Grep/Glob — и обязан вернуть один текст на пять секций. Для
 * окна 32k это «прочитай всё и напиши всё», и локальная модель делает одно из двух:
 * упирается в лимит длины или печатает зелёный бланк, не читая (класс «оформитель»,
 * замер 2026-09-08). Та же природа, что у этапа 5 до `stepFill`: порог не в весах, а в
 * протоколе — открытый агентный цикл против конвейера закрытых шагов рантайма.
 *
 * Здесь рантайм ведёт конвейер сам: режет diff на фрагменты по файлам (и по `@@` — под
 * потолок байт), на каждый фрагмент задаёт ОДИН вопрос с фиксированным списком классов
 * дефектов, на КАЖДУЮ ось плана (не только объявленные не затронутыми — трек 1а,
 * 2026-09-08) — вопрос «трогает ли» для незатронутой, «покрывает ли заявленный исход
 * реально сделанное» для затронутой. Ответы разбираются общим `normalize('record_finding')`,
 * чтобы форма не разошлась с вердиктом, и принимаются тем же `acceptRecord`, что и записи
 * модели.
 *
 * Что здесь НЕ делается:
 *  - это не «дожимание». CR-Bench (arXiv 2603.11078): повторные «а точно ничего?» роняют
 *    сигнал/шум слабой модели до 0.91. Вопрос задаётся один раз, «нет» — штатный ответ,
 *    и обе метрики (посевы И `--seed none`) меряются вместе;
 *  - это не второй канал записи: находка идёт через `normalize` → `acceptRecord` → рендер
 *    рантайма → гейт одобрения → вердикт, как и любая другая;
 *  - это не замена рецензента для флоу `sdk`: там свободный ход остаётся как был.
 *
 * Независимые данные, на которые опирается конструкция: arXiv 2606.15689 — F1 лучшей
 * модели на diff > 150 строк падает до 0.043, то есть нарезка входа важнее размера модели;
 * SWR-Bench — пять узких прогонов дешёвой модели обходят один прогон дорогой.
 */

import type { NormalizedCall, Usage } from '@sdlc-runner/shared';

import type { AxisName } from '../artifacts/planAxes.ts';
import { normalize } from '../exec/normalize.ts';
import type { ChatProvider } from '../provider/ChatProvider.ts';
import { packForClaim, splitHunks, topFileForClaim, type Hunk } from './claimEvidence.ts';

/** Строка осей плана, как её видит конвейер: имя, затронута ли по плану, исход как есть. */
export interface AxisAsk {
  name: string;
  affected: boolean | null;
  outcomeRaw: string;
}

export interface ReviewFillInput {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  /** Пункты приёмки и инварианты задачи — дословно, для контекста вопроса. */
  taskContext: string;
  /** Патч попытки, перегенерированный рантаймом. */
  diff: string;
  /**
   * Оси из секции «Последствия шагов» плана. Спрашиваются ВСЕ шесть, не только
   * объявленные не затронутыми (трек 1а, 2026-09-08): план может пометить ось
   * «затронута» со ссылкой на claim, который покрывает СОВСЕМ ДРУГОЕ изменение, чем то,
   * что реально в diff'е под тем же ярлыком оси — посев `axis-config-blind` пропущен
   * именно так. `planAxisProblems` проверяет, что адресат исхода СУЩЕСТВУЕТ (claim-N
   * реально в задаче), но не то, что он реально покрывает конкретное поведение diff'а;
   * тем же слепым местом страдает и свободный ход рецензента — здесь оно закрывается.
   */
  axes: readonly AxisAsk[];
  /** Потолок одного фрагмента — окно локальной модели, а не вкус. */
  hunkBudgetBytes: number;
  signal: AbortSignal;
  /** Ход конвейера для ленты оператора: какой фрагмент/ось спрашивается. */
  onProgress?: (note: string) => void;
  /**
   * Токены/стоимость КАЖДОГО запроса конвейера — вызывающий обязан довести их до
   * `SpentLedger`/бюджетного гарда маршрута тем же путём, что и у обычного хода
   * (`executor.run()`'s `hooks.onUsage`). Без колбэка эти вызовы (до ~7 хунков + 6 осей за
   * попытку) были бы «бесплатными» для гарда `maxBudgetUsd` и для отчёта расхода — реальная
   * дыра для платных моделей с `reviewFill: true`.
   */
  onUsage?: (usage: Usage) => void;
}

export interface ReviewFillResult {
  /** Разобранные записи `record_finding` — принимаются вызывающим через `acceptRecord`. */
  findings: NormalizedCall[];
  hunksAsked: number;
  hunksAnswered: number;
  axesAsked: number;
  axesAnswered: number;
  /** Сводка для входа этапа — тем же блоком, что текст свободного рецензента. */
  text: string;
}

/**
 * Классы дефектов, по которым проверяется каждый фрагмент. Список закрытый и короткий
 * намеренно: он повторяет классы посевов стенда (`bench/src/seeds.ts`) и категории,
 * по которым независимые бенчмарки ревью меряют recall, — а не «всё, что бывает».
 */
export const DEFECT_CHECKLIST: readonly string[] = [
  'чтение переменной окружения или настройки без умолчания и без проверки значения',
  'секрет, токен, адресат, персональные данные — в логе, сообщении об ошибке или выводе',
  'проглоченное исключение: пустой catch, подмена исключения на return или значение по умолчанию',
  'граница: «>» против «>=», «ровно N» против «больше N», сдвиг на единицу в порогах и индексах',
  'удалённое или изменённое поведение, на которое рассчитывали вызывающие',
  'тест, который ничего не проверяет: самореферентные ожидания, NaN против NaN, проверка, проходящая при любой реализации',
  'число или строка, не совпадающие с названными в задаче',
];

/**
 * Что считается затрагиванием оси — подсказка модели, а не критерий вердикта. Ключи —
 * `AxisName` из `planAxes.ts`, не строковый литерал сам по себе: добавление седьмой оси в
 * канон (`AXES`) даст ошибку типов здесь же, а не молчаливый `axisHint()`-фолбэк
 * («изменения, которые сказываются на этой оси») для новой оси, которую никто не забыл
 * бы добавить в канон, но забыл бы добавить сюда.
 */
export const AXIS_HINTS: Readonly<Record<AxisName, string>> = {
  Безопасность: 'проверка прав и входных данных, секреты, экранирование, доверие к внешнему вводу',
  'Ресурсы и скорость': 'циклы по большим коллекциям, повторные запросы, память, таймауты, кэш',
  'Отказы зависимостей': 'вызовы сети/диска/БД/внешних сервисов и что происходит при их ошибке или недоступности',
  Настройки: 'чтение process.env, конфигов, флагов, умолчаний; новые параметры',
  'Совместимость и данные': 'форматы файлов и сообщений, схемы, миграции, публичные сигнатуры и экспорты',
  Наблюдаемость: 'console.*, логгеры, метрики, трассировка — что и с какими данными попадает в вывод',
};

export function axisHint(name: string): string {
  // `Object.keys` не сужает до `AxisName[]` даже для типизированного Record — ключи здесь
  // ровно те, что в `AXIS_HINTS`, кастуем осознанно.
  const key = (Object.keys(AXIS_HINTS) as AxisName[]).find((k) => k.toLowerCase() === name.trim().toLowerCase());
  return key === undefined ? 'изменения, которые сказываются на этой оси' : AXIS_HINTS[key];
}

/**
 * Обрезка по БАЙТАМ, а не по code unit'ам JS-строки: `String.prototype.slice` считает
 * UTF-16 code unit'ы, а потолок фрагмента — байтовый (см. докстринг `hunkBudgetBytes`).
 * Русский текст (кириллица — 2 байта на символ в UTF-8) на `.slice(0, budgetBytes)` резался
 * бы почти вдвое длиннее потолка.
 *
 * Резать `Buffer` НАУГАД тоже нельзя: обрубленный посреди многобайтового символа хвост
 * `Buffer.toString('utf8')` молча долечивает символом U+FFFD, а он сам занимает 3 байта в
 * UTF-8 — обрезка «до 100 байт» после такого долечивания оказывалась НА БАЙТ-ДРУГОЙ длиннее
 * потолка (живой прогон теста ловил 102 байта на потолке 100). Отступаем назад до границы
 * символа: continuation-байт UTF-8 всегда начинается с бит `10` — сдвигаем срез, пока на
 * границе не окажется НЕ continuation-байт, то есть целый символ либо ничего от него.
 */
function truncateToBytes(text: string, budgetBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= budgetBytes) return text;
  let end = budgetBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Фрагменты под потолок: хунк по файлу, а если он больше потолка — по границам `@@`.
 * Один фрагмент никогда не пуст; фрагмент, не влезающий даже одним `@@`, обрезается —
 * лучше проверить начало, чем не проверить ничего. Обрезаются ОБА места, где фрагмент
 * может уйти за потолок: и «не влез следующий `@@`» посреди цикла, и хвост после него —
 * раньше клэмп стоял только на хвосте, и фрагмент, не влезший уже на середине, уходил
 * модели целиком, без обрезки вовсе.
 */
export function sliceHunks(hunks: readonly Hunk[], budgetBytes: number): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    if (Buffer.byteLength(h.text, 'utf8') <= budgetBytes) {
      out.push(h);
      continue;
    }
    const [head = '', ...parts] = h.text.split(/\n(?=@@ )/);
    let acc = head;
    for (const p of parts) {
      const candidate = `${acc}\n${p}`;
      if (Buffer.byteLength(candidate, 'utf8') <= budgetBytes) {
        acc = candidate;
      } else {
        if (acc.trim() !== '') out.push({ file: h.file, text: truncateToBytes(acc, budgetBytes) });
        acc = `${head}\n${p}`;
      }
    }
    if (acc.trim() !== '') {
      out.push({ file: h.file, text: truncateToBytes(acc, budgetBytes) });
    }
  }
  return out;
}

const SECTION_ALIASES: Readonly<Record<string, string>> = {
  review: 'review',
  ревью: 'review',
  расхождение: 'review',
  дефект: 'review',
  scope: 'scope',
  объём: 'scope',
  границы: 'scope',
  invariant: 'invariant',
  инвариант: 'invariant',
  regression: 'regression',
  регрессия: 'regression',
};

/** Ответ «дефектов нет» в любой из ожидаемых форм. */
export function isNoAnswer(answer: string): boolean {
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'));
  if (lines.length === 0) return true;
  return lines.every((l) => /^(нет|no|none|н\/п)[.!]?$/i.test(l));
}

/**
 * Разбор ответа по фрагменту: строки `СЕКЦИЯ | ЧТО НЕ ТАК | МЕСТО`. Строка без места
 * получает файл фрагмента — модель видела только его, и это честная привязка. Строки,
 * не разобравшиеся общим нормализатором, выбрасываются: пятой секции не бывает.
 */
export function parseFindingAnswer(answer: string, fallbackEvidence: string): NormalizedCall[] {
  if (isNoAnswer(answer)) return [];
  const out: NormalizedCall[] = [];
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (line === '' || line.startsWith('```') || !line.includes('|')) continue;
    const [sec = '', text = '', where = ''] = line.split('|').map((p) => p.trim());
    const section = SECTION_ALIASES[sec.toLowerCase().replace(/[«»"'`]/g, '')];
    if (section === undefined || text === '' || /^(нет|no|none)$/i.test(text)) continue;
    const call = normalize('record_finding', {
      section,
      text,
      evidence: where === '' ? fallbackEvidence : where,
    });
    if (call.kind === 'record_finding') out.push(call);
  }
  return out;
}

/**
 * Утвердительный ответ («да»/«yes») в начале строки. `\b` после кириллицы не работает
 * (граница слова считается по ASCII — см. CLAUDE.md, тот же класс бага уже ловился в
 * `gatesFile.ts`): `/^да\b/i.test('да')` — `false`. Окончание перечислено явно:
 * пробел/пунктуация/конец строки — но не любая буква (иначе «дальше», «давно» тоже
 * считались бы утвердительным ответом).
 */
export const AFFIRMATIVE_HEAD = /^(?:да(?=\s|[—:,.!]|$)|yes\b)/i;

/**
 * Ответ по оси: `нет` либо `да | что именно | место`.
 *
 * `declared` различает, ЧТО утверждал план — текст находки обязан называть расхождение
 * с ЗАЯВЛЕННЫМ, а не с одной и той же фразой на оба случая: «объявлена не затронутой, а
 * diff трогает» и «объявлена затронутой, а заявленный исход не покрывает» — два разных
 * утверждения плана, и оба обязаны узнаваться `AXES_LABEL`/`verdict/collect.ts` как
 * подтверждённое расхождение по осям (текст начинается с «Оси «Последствий шагов»»).
 */
export function parseAxisAnswer(
  axis: string,
  answer: string,
  fallbackEvidence: string,
  declared: boolean,
): NormalizedCall | null {
  if (isNoAnswer(answer)) return null;
  const line = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'))
    .find((l) => AFFIRMATIVE_HEAD.test(l) || l.includes('|'));
  if (line === undefined) return null;
  const parts = line.split('|').map((p) => p.trim());
  const head = parts[0] ?? '';
  if (!AFFIRMATIVE_HEAD.test(head) && parts.length < 2) return null;
  const what =
    (parts.length >= 2 ? parts[1] : head.replace(AFFIRMATIVE_HEAD, '').replace(/^[\s:,—-]+/, '')) ?? '';
  const where = parts[2] ?? '';
  if (what.trim() === '') return null;
  const text = declared
    ? `Оси «Последствий шагов»: «${axis}» — в плане объявлена затронутой, но заявленный исход не покрывает: ${what.trim()}`
    : `Оси «Последствий шагов»: «${axis}» — в плане объявлена не затронутой, а diff её трогает: ${what.trim()}`;
  const call = normalize('record_finding', {
    section: 'review',
    text,
    evidence: where === '' ? fallbackEvidence : where,
  });
  return call.kind === 'record_finding' ? call : null;
}

function systemPrompt(taskContext: string): string {
  return [
    'Ты — независимый рецензент правки кода. Твоя цель — опровергнуть, что сделано нужное,',
    'но только по тому, что видно в показанном фрагменте: не гадай о коде, которого не видишь.',
    'Находка без места из фрагмента не считается. Если дефектов из списка нет — так и скажи одним словом.',
    '',
    '## Задача (приёмочный лист и инварианты)',
    '',
    taskContext.trim() === '' ? '(пункты задачи не переданы)' : taskContext.trim(),
  ].join('\n');
}

function hunkQuestion(h: Hunk, n: number, total: number): string {
  return [
    `## Фрагмент ${n} из ${total} — файл \`${h.file}\``,
    '',
    '```diff',
    h.text,
    '```',
    '',
    'Проверь ТОЛЬКО этот фрагмент по списку классов дефектов:',
    ...DEFECT_CHECKLIST.map((c, i) => `${i + 1}. ${c};`),
    '',
    'Ответь строками вида `СЕКЦИЯ | ЧТО НЕ ТАК | файл:строка или символ` — по строке на находку.',
    'СЕКЦИЯ — одно из: review (дефект или расхождение с задачей), scope (правка вне задачи),',
    'invariant (нарушен инвариант задачи), regression (сломано прежнее поведение).',
    'Если в этом фрагменте дефектов из списка нет — ответь одним словом: нет.',
    'Ничего, кроме этих строк, не пиши.',
  ].join('\n');
}

/** Один блок оси внутри комбинированного вопроса — общая часть с прежним одиночным `axisQuestion`. */
function axisBlock(n: number, axis: AxisAsk, pack: string): string {
  const declared = axis.affected === true;
  return [
    declared
      ? `### ${n}. Ось «${axis.name}» — в плане объявлена ЗАТРОНУТОЙ`
      : `### ${n}. Ось «${axis.name}» — в плане объявлена НЕ затронутой`,
    '',
    `Что считается затрагиванием: ${axisHint(axis.name)}.`,
    axis.outcomeRaw.trim() === '' ? '' : `Исход по плану: ${axis.outcomeRaw.trim()}`,
    '',
    'Изменения попытки, относящиеся к этой оси (срез патча):',
    '',
    '```diff',
    pack === '' ? '(подходящих правок не нашлось)' : pack,
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * ВСЕ оси — ОДНИМ запросом, а не по одному (трек «сумма латентности», 2026-09-09).
 *
 * Замер показал: модель без ручки `reasoning_effort` тратит на «размышление» ~130 с на
 * запрос ПОЧТИ НЕЗАВИСИМО от размера содержимого (probe: тривиальный вопрос — секунды,
 * содержательный — те же ~130 с, что и полноценный вопрос по оси) — сумма 21 отдельного
 * запроса конвейера упирается в бюджет стенных часов раньше, чем в качество ответов, и
 * параллельные пачки (`REVIEW_PARALLEL`) этого не снимают: сервер сериализует генерацию
 * независимо от того, сколько запросов пришло «одновременно» (см. `docs/model-runs.md`).
 * Значит рычаг — число ЗАПРОСОВ, а не их размер: шесть осей, объединённые в один вопрос,
 * платят цену размышления ОДИН раз вместо шести.
 *
 * Хунки НЕ объединяются тем же приёмом: разбиение по хункам защищает не время, а recall —
 * «прочитай всё, ответь по всему» и есть класс «оформитель», ради которого писался весь
 * конвейер (докстринг модуля). Совмещение осей recall не угрожает: срез под каждую ось уже
 * мал и ограничен потолком независимо от того, сколько осей приходит в одном вопросе.
 */
function axesCombinedQuestion(axes: readonly AxisAsk[], packs: readonly string[]): string {
  return [
    `## Оси «Последствий шагов» — проверь КАЖДУЮ из ${axes.length} ниже`,
    '',
    ...axes.map((axis, idx) => axisBlock(idx + 1, axis, packs[idx] ?? '')),
    '',
    `Ответь РОВНО ${axes.length} строками — по одной на каждую ось, В ТОМ ЖЕ ПОРЯДКЕ, ` +
      'начиная с номера оси:',
    '`N. нет` — для затронутой оси это значит «заявленный исход покрывает всё видимое в срезе»,',
    'для незатронутой — «правка эту ось не трогает».',
    '`N. да | что именно | файл:строка` — для затронутой: что НЕ покрыто заявленным исходом;',
    'для незатронутой: что именно трогает эту ось.',
    'Ничего, кроме этих строк, не пиши.',
  ].join('\n');
}

/**
 * Разбор комбинированного ответа по осям: строки `N. …`, N — порядковый номер оси в ТОМ ЖЕ
 * запросе. Разбор одной строки делегирован `parseAxisAnswer` (без изменений в его контракте)
 * — второго места, знающего форму ответа «да/нет по оси», не появляется.
 */
export function parseAxesCombinedAnswer(
  axes: readonly AxisAsk[],
  answer: string,
  fallbackEvidence: readonly string[],
): { answeredIdx: Set<number>; findings: NormalizedCall[] } {
  const answeredIdx = new Set<number>();
  const findings: NormalizedCall[] = [];
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'));
  for (const line of lines) {
    const m = /^(\d+)\.\s*(.*)$/.exec(line);
    if (m === null) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= axes.length || answeredIdx.has(idx)) continue;
    answeredIdx.add(idx);
    const axis = axes[idx]!;
    const rest = m[2] ?? '';
    if (rest.trim() === '') continue;
    const call = parseAxisAnswer(axis.name, rest, fallbackEvidence[idx] ?? '', axis.affected === true);
    if (call !== null) findings.push(call);
  }
  return { answeredIdx, findings };
}

/**
 * Пачка параллельных вопросов — по образцу `FormFillExecutor.FIELD_PARALLEL`
 * (`Promise.allSettled`, тот же паттерн). Число подбирается первым живым замером трека 2
 * (docs/model-runs.md): вопрос reviewFill тяжелее вопроса формы — несёт срез diff'а, а не
 * одну строку бланка, — поэтому то же число не гарантированно то же по выгоде.
 */
const REVIEW_PARALLEL = 3;

/**
 * Конвейер: фрагменты diff'а пачками (трек 2, 2026-09-09), затем ВСЕ оси плана ОДНИМ
 * запросом (трек «сумма латентности», 2026-09-09 — см. докстринг `axesCombinedQuestion`).
 *
 * Хунки — пачками: латентность одного запроса, помноженная на число вопросов конвейера,
 * суммарно упирается в бюджет стенных часов раньше, чем в качество ответов (замер
 * 2026-09-08 — `apriel-1.6-15b-rf`, обрыв на 12-м вопросе добора claimFill;
 * `docs/model-runs.md`). `signal.aborted` проверяется перед КАЖДОЙ пачкой, а не перед
 * каждым вопросом внутри неё — отменённая пачка не откатывает уже пришедшие в ней ответы,
 * отмена лишь не начинает следующую. Упавший запрос по-прежнему считается «не отвечено» и
 * не прячется (`ask` ловит исключение сам, `Promise.allSettled` не теряет соседей
 * упавшего): `hunksAnswered < hunksAsked` — сигнал вызывающему, что ревью неполное.
 *
 * Оси — НЕ пачками: живой замер 2026-09-09 показал, что параллельные пачки не снимают
 * латентность (сервер сериализует генерацию независимо от числа «одновременных» запросов
 * клиента), а цена одного запроса (~130 с на этой модели) почти не зависит от размера
 * содержимого — значит рычаг: меньше ЗАПРОСОВ, а не быстрее каждый. Хунки этим приёмом
 * не объединяются — разбиение по хункам защищает recall, а не время (докстринг модуля).
 */
export async function reviewByHunks(i: ReviewFillInput): Promise<ReviewFillResult> {
  const hunks = splitHunks(i.diff);
  const slices = sliceHunks(hunks, i.hunkBudgetBytes);
  const system = systemPrompt(i.taskContext);
  const findings: NormalizedCall[] = [];
  let hunksAnswered = 0;
  let axesAnswered = 0;

  const ask = async (user: string): Promise<string | null> => {
    try {
      const r = await i.provider.chat({
        model: i.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        tools: [],
        signal: i.signal,
        temperature: null,
        params: i.params,
      });
      i.onUsage?.(r.usage);
      return r.text;
    } catch (e) {
      i.onProgress?.(`вопрос не отвечен: ${(e as Error).message}`);
      return null;
    }
  };

  for (let batchStart = 0; batchStart < slices.length; batchStart += REVIEW_PARALLEL) {
    if (i.signal.aborted) break;
    const batch = slices.slice(batchStart, batchStart + REVIEW_PARALLEL);
    i.onProgress?.(
      batch.length === 1
        ? `фрагмент ${batchStart + 1} из ${slices.length}: ${batch[0]!.file}`
        : `пачка фрагментов ${batchStart + 1}–${batchStart + batch.length} из ${slices.length}`,
    );
    const answers = await Promise.allSettled(
      batch.map((h, idx) => ask(hunkQuestion(h, batchStart + idx + 1, slices.length))),
    );
    for (const [idx, h] of batch.entries()) {
      const a = answers[idx]!;
      const answer = a.status === 'fulfilled' ? a.value : null;
      if (answer === null) continue;
      hunksAnswered++;
      findings.push(...parseFindingAnswer(answer, h.file));
    }
  }

  // Все оси, не только «незатронутые» по плану (трек 1а) — план может пометить ось
  // затронутой со ссылкой на claim, который покрывает не то изменение, что реально в
  // diff'е под этим ярлыком; см. докстринг `ReviewFillInput.axes`. ОДНИМ запросом на все
  // оси разом — см. докстринг `axesCombinedQuestion`.
  if (i.axes.length > 0 && !i.signal.aborted) {
    const axisQueries = i.axes.map((axis) => `${axis.name} ${axisHint(axis.name)}`);
    const packs = axisQueries.map((q) => packForClaim(q, hunks, i.hunkBudgetBytes));
    const fallbackFiles = axisQueries.map((q) => topFileForClaim(q, hunks) ?? hunks[0]?.file ?? '');
    i.onProgress?.(`оси одним запросом: ${i.axes.map((a) => a.name).join(', ')}`);
    const answer = await ask(axesCombinedQuestion(i.axes, packs));
    if (answer !== null) {
      const { answeredIdx, findings: axisFindings } = parseAxesCombinedAnswer(i.axes, answer, fallbackFiles);
      // Успешный ОТВЕТ (запрос не упал) засчитывает конвейеру ВСЕ оси — контракт
      // `axesAnswered`/`axesAsked` про «рантайм провёл обмен», а не «модель ответила
      // по форме на каждую строку»; см. докстринг `ReviewFillInput.onUsage` — тот же
      // принцип уже действует для `hunksAnswered` (падение самого запроса, не разбора).
      axesAnswered = i.axes.length;
      findings.push(...axisFindings);
      if (answeredIdx.size < i.axes.length) {
        i.onProgress?.(`ответ по осям неполон: разобрано ${answeredIdx.size} из ${i.axes.length} строк`);
      }
    }
  }

  const files = [...new Set(hunks.map((h) => h.file))];
  const text = [
    `Ревью по хункам (reviewFill): фрагментов проверено ${hunksAnswered} из ${slices.length}, ` +
      `осей сверено ${axesAnswered} из ${i.axes.length}.`,
    `Проверенные файлы: ${files.length === 0 ? '(патч пуст)' : files.join(', ')}.`,
    '',
    findings.length === 0
      ? 'Находок нет: ни один фрагмент не дал дефекта из списка, ни одна «не затронутая» ось не тронута.'
      : ['Находки:', ...findings.map((f) => (f.kind === 'record_finding' ? `- (${f.section}) ${f.text} — ${f.evidence}` : ''))].join('\n'),
  ].join('\n');

  return {
    findings,
    hunksAsked: slices.length,
    hunksAnswered,
    axesAsked: i.axes.length,
    axesAnswered,
    text,
  };
}
