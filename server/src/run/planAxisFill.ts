/**
 * Топ-ап этапа 4 (plan) по осям прод-готовности — тот же приём, что `reviewFill`/`claimFill`
 * дают этапу 6: узкий закрытый вопрос вместо того, чтобы просить слабую модель разобрать
 * секцию «Последствия шагов» одним открытым суждением внутри её же хода.
 *
 * Устроено СИММЕТРИЧНО `claimFill.ts`, не `reviewFill.ts`: это ДОБОР после хода модели, а не
 * замена его части. `finishGuard`/`axisProblems()` (`Run.ts`) остаются работать как раньше —
 * топ-ап встраивается ПЕРЕД ними в цикле этапа, дозаполняя только те оси, о которых модель
 * НИЧЕГО не сказала (`unansweredAxes` в `planAxes.ts` — не путать с более широким
 * `planAxisProblems`, которая ловит ещё и СЕМАНТИЧЕСКИ неверный ответ; топ-ап не переписывает
 * решение, которое модель уже приняла, пусть и сославшись на несуществующий адресат — это
 * решение человек обязан увидеть и поправить сам).
 *
 * Что здесь НЕ происходит:
 *  - это не решение за модель. Ось, ответ на которую топ-ап не смог разобрать, остаётся
 *    незаполненной — `finishGuard` увидит её на следующем заходе и честно потребует
 *    доделать, тем же приёмом, что и до этой правки;
 *  - это не второй канал записи в план. Ответ идёт через `applyAxisAnswers`
 *    (`artifacts/renderAxes.ts`) — тем же путём в файл, что и весь остальной текст плана,
 *    просто дописанным рантаймом, а не собственной рукой модели.
 */

import type { Usage } from '@sdlc-runner/shared';

import { AFFIRMATIVE_HEAD, AXIS_HINTS, axisHint } from './reviewFill.ts';
import { ProviderEnvError, type ChatProvider } from '../provider/ChatProvider.ts';
import type { AxisName } from '../artifacts/planAxes.ts';
import type { AxisFillAnswer } from '../artifacts/renderAxes.ts';

export interface PlanAxisFillInput {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  /** Системный промпт этапа — тот же, что видел основной ход. */
  system: string;
  /** Оси, на которые секция плана не дала ответа (`unansweredAxes`). */
  axes: readonly AxisName[];
  /** Текст плана — источник шагов; передаётся целиком, срез не нужен: план один документ. */
  planText: string;
  /** Секция «Опоры осей» отчёта разведки, если гейт был включён на этапе 2. Пусто — нет. */
  axisSupportText: string;
  /** id пунктов приёмочного листа задачи — доступные адресаты исхода `claim-N`. */
  claimIds: readonly string[];
  /** Имена ВКЛЮЧЁННЫХ строк набора гейтов — доступные адресаты исхода «гейт». */
  enabledGates: readonly string[];
  /** В задаче есть незакрытый вопрос — адресат исхода «следующий виток» существует. */
  hasOpenQuestion: boolean;
  /** В задаче названы инварианты — адресат исхода «инвариант» существует. */
  hasInvariants: boolean;
  signal: AbortSignal;
  onProgress?: (note: string) => void;
  /** Токены/стоимость каждого запроса — см. докстринг `ReviewFillInput.onUsage` в reviewFill.ts. */
  onUsage?: (usage: Usage) => void;
}

export interface PlanAxisFillResult {
  answers: AxisFillAnswer[];
  /** Первая ошибка СРЕДЫ — см. докстринг `ClaimFillResult.envFailure` в claimFill.ts. */
  envFailure: string | null;
}

function axisBlock(n: number, axis: AxisName): string {
  return `### ${n}. Ось «${axis}» — ${axisHint(axis)}`;
}

function planAxisQuestion(i: PlanAxisFillInput): string {
  return [
    `## Разбор последствий — заполни ${i.axes.length} осей, которые план ещё не разобрал`,
    '',
    'Ниже — шаги плана целиком и то, что уже известно о проекте по этим осям.',
    '',
    '## Шаги плана',
    '',
    i.planText.trim(),
    ...(i.axisSupportText.trim() === ''
      ? []
      : ['', '## Что уже есть в проекте по этим осям (из разведки)', '', i.axisSupportText.trim()]),
    '',
    '## Доступные адресаты исхода',
    '',
    `- Пункты приёмки: ${i.claimIds.length === 0 ? '(в задаче нет ни одного пункта)' : i.claimIds.join(', ')}`,
    `- Включённые гейты набора: ${i.enabledGates.length === 0 ? '(в наборе нет включённых строк)' : i.enabledGates.map((g) => `«${g}»`).join(', ')}`,
    `- Открытый вопрос в задаче: ${i.hasOpenQuestion ? 'есть' : 'нет'}`,
    `- Инвариант назван в задаче: ${i.hasInvariants ? 'да' : 'нет'}`,
    '',
    '## Оси',
    '',
    ...i.axes.map((a, idx) => axisBlock(idx + 1, a)),
    '',
    `Ответь РОВНО ${i.axes.length} строками — по одной на каждую ось выше, В ТОМ ЖЕ ПОРЯДКЕ, ` +
      'начиная с номера оси:',
    '',
    '`N. да/нет | что именно в шагах, файл:символ / почему ось не затронута | исход`',
    '',
    'исход — РОВНО одно из закрытого словаря, ссылаясь ТОЛЬКО на реально существующие ' +
      'адресаты из списка выше:',
    '- `claim-N` — пункт УЖЕ в приёмочном листе (не выдумывай новый id);',
    '- `инвариант` — только если в задаче назван хоть один;',
    '- `гейт «имя дословно»` — только имя из списка включённых гейтов выше;',
    '- `следующий виток` — только если в задаче есть открытый вопрос;',
    '- `н/п — причина` — ось не затронута, причина обязательна;',
    '- риск: ЧЕТЫРЕ части ПОСЛЕ обычных «да/нет | что именно в шагах» (итого ШЕСТЬ частей ' +
      'строки, не три) — `риск | что может пойти не так | почему допустимо сейчас | когда ' +
      'вернуться`, все три поля после слова «риск» заполнены всегда.',
    '',
    'Не ссылайся на claim/гейт/вопрос/инвариант, которых нет в списках выше — несуществующий ' +
      'адресат не считается ответом. Ничего, кроме этих строк, не пиши.',
  ].join('\n');
}

/**
 * `\b` после кириллицы не работает (граница слова считается по ASCII — см. CLAUDE.md, тот
 * же класс бага уже ловился в `gatesFile.ts` и `reviewFill.ts`): `/^да\b/i.test('да')` —
 * `false`, «да» на всю строку не матчится вовсе. Утвердительная половина переиспользует
 * `AFFIRMATIVE_HEAD` из `reviewFill.ts` — та же проверка, тот же класс бага, один источник
 * правды вместо второй копии того же объяснения. У «нет» готового экспорта нет (в
 * `reviewFill.ts` отсутствие «да» само по себе значит «нет» — здесь формат другой,
 * `да`/`нет` идут явным первым полем), поэтому она заведена локально тем же приёмом.
 */
const NEGATIVE = /^нет(?=\s|[—:,.!]|$)/i;
/**
 * Окончания риска перечислены явно той же группой, что и в `planAxes.ts`'s `OUTCOME_WORDS`
 * (риск/риски/риска/риском/…) — иначе ответ модели «риски: …» (множественное число) не
 * матчился бы здесь, но матчился бы при последующем ЧТЕНИИ той же строки, и `planAxisProblems`
 * рапортовал бы «исход «риск», но строки в таблице рисков нет» на строке, которую сам же
 * топ-ап и не смог правильно разобрать (ревью).
 */
const RISK_HEAD = /^риск(?:и|а|ом|у|е|ов|ам)?(?=\s|[—:,.!]|$)/i;

/**
 * Разбор одной строки `N. да/нет | что именно | исход` (или шестичастной для «риска»:
 * да/нет | что именно | риск | риск словами | почему допустимо | когда вернуться).
 * `null` — строка не разобралась (номер вне диапазона, дубль, пустые поля).
 */
function parseOneAxisAnswer(axis: AxisName, rest: string): AxisFillAnswer | null {
  const parts = rest.split('|').map((p) => p.trim());
  if (parts.length < 3) return null;
  const [affectedRaw = '', what = '', outcomeHead = ''] = parts;
  const affected = AFFIRMATIVE_HEAD.test(affectedRaw) ? true : NEGATIVE.test(affectedRaw) ? false : null;
  if (affected === null || what === '') return null;

  if (RISK_HEAD.test(outcomeHead)) {
    // Шесть частей, не пять: «риск» — своё поле (part[2]), «риск словами» для таблицы
    // принятых рисков — ОТДЕЛЬНОЕ part[3], не то же самое, что «что именно в шагах»
    // (part[1]) — прежде код по ошибке переиспользовал `what` для обеих колонок сразу
    // (ревью, живой замер axisfill-gptossrf-1/2, 2026-09-09).
    if (parts.length < 6) return null;
    const [, , , riskWhat = '', why = '', revisit = ''] = parts;
    if (riskWhat.trim() === '' || why.trim() === '' || revisit.trim() === '') return null;
    return {
      axis,
      affectedText: affected ? 'да' : 'нет',
      what,
      outcome: 'риск',
      risk: { what: riskWhat.trim(), why: why.trim(), revisit: revisit.trim() },
    };
  }

  if (outcomeHead === '') return null;
  return { axis, affectedText: affected ? 'да' : 'нет', what, outcome: outcomeHead };
}

export function parsePlanAxesCombinedAnswer(
  axes: readonly AxisName[],
  answer: string,
): { answeredIdx: Set<number>; answers: AxisFillAnswer[] } {
  const answeredIdx = new Set<number>();
  const answers: AxisFillAnswer[] = [];
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'));
  for (const line of lines) {
    const m = /^(\d+)\.\s*(.*)$/.exec(line);
    if (m === null) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= axes.length || answeredIdx.has(idx)) continue;
    const rest = m[2] ?? '';
    if (rest.trim() === '') continue;
    const parsed = parseOneAxisAnswer(axes[idx]!, rest);
    if (parsed === null) continue;
    answeredIdx.add(idx);
    answers.push(parsed);
  }
  return { answeredIdx, answers };
}

/** См. докстринг модуля. Одним комбинированным запросом — тот же приём, что `axesCombinedQuestion`. */
export async function fillPlanAxes(i: PlanAxisFillInput): Promise<PlanAxisFillResult> {
  if (i.axes.length === 0) return { answers: [], envFailure: null };

  let response: Awaited<ReturnType<ChatProvider['chat']>>;
  try {
    response = await i.provider.chat({
      model: i.model,
      messages: [
        { role: 'system', content: i.system },
        { role: 'user', content: planAxisQuestion(i) },
      ],
      tools: [],
      signal: i.signal,
      temperature: null,
      params: i.params,
    });
  } catch (e) {
    const envFailure = e instanceof ProviderEnvError ? e.message : null;
    const why = e instanceof Error ? e.message : String(e);
    i.onProgress?.(`оси плана не отвечены: ${why}`);
    return { answers: [], envFailure };
  }
  i.onUsage?.(response.usage);
  const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(i.axes, response.text);
  if (answeredIdx.size < i.axes.length) {
    i.onProgress?.(`ответ по осям плана неполон: разобрано ${answeredIdx.size} из ${i.axes.length}`);
  }
  return { answers, envFailure: null };
}

// Реэкспорт подсказок — вызывающему (`Run.ts`) не нужно знать, что они физически живут в
// `reviewFill.ts`; обе стороны (этап 4 и этап 6) читают ОДИН и тот же канон осей.
export { AXIS_HINTS, axisHint };
