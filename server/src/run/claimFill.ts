/**
 * Поклаймовый добор этапа 6: по одному вопросу на пункт приёмки.
 *
 * Тот же приём, что дал `formFill` на этапах-документах («Да, решающе для закрытия
 * этапа»), применённый к единственной части этапа 6, которая этому поддаётся: у
 * дешёвой модели порог «удержать линейную работу на 60 ходов» лежит ниже порога
 * «разобрать один пункт по срезу патча».
 *
 * Что здесь НЕ происходит:
 *  - это не замена ревью. Целый патч читает независимый рецензент, и кросс-файловый
 *    дефект виден только там. Добор отвечает на узкий вопрос «чем подтверждается вот
 *    ЭТОТ пункт» и запускается ПОСЛЕ основного хода — только по пунктам, о которых
 *    модель не сказала ничего;
 *  - это не второй канал записи. Ответ превращается в тот же `record_claim` через
 *    `normalize` — единственное место, где форма аргументов имеет значение, — и дальше
 *    идёт общим путём: рендер отчёта, гейт одобрения, вердикт;
 *  - это не решение за модель. Пункт, на который она ответила невнятно, остаётся
 *    незаполненным и честно роняет вердикт как «не проверяем».
 */

import type { NormalizedCall, Usage } from '@sdlc-runner/shared';

import { normalize } from '../exec/normalize.ts';
import { ProviderEnvError, type ChatProvider } from '../provider/ChatProvider.ts';
import { claimsSchema, withResponseFormat } from '../provider/responseFormat.ts';
import { packForClaim, splitHunks } from './claimEvidence.ts';

export interface ClaimAsk {
  id: string;
  /** Текст пункта из приёмочного листа задачи — дословно. */
  text: string;
}

export interface ClaimFillInput {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  /** Системный промпт этапа — тот же, что видел основной ход. */
  system: string;
  claims: readonly ClaimAsk[];
  /** Патч попытки, перегенерированный рантаймом. */
  diff: string;
  /** Вывод тестов попытки, если он есть. */
  tests: string;
  /** Потолок среза патча на один вопрос — окно локальной модели, а не вкус. */
  evidenceBudgetBytes: number;
  signal: AbortSignal;
  /** Упавший в пачке запрос — оператору, тем же приёмом, что `ReviewFillInput.onProgress`. */
  onProgress?: (note: string) => void;
  /** Токены/стоимость каждого запроса — см. докстринг `ReviewFillInput.onUsage`, тот же долг. */
  onUsage?: (usage: Usage) => void;
  /**
   * Форма ответа группы гарантируется декодером сервера (`response_format`) — см.
   * `ModelDef.constrainedChoice`. Ответ вне JSON-схемы (сервер её проигнорировал) не роняет
   * группу: разбор падает обратно на строчный формат (`parseClaimsCombinedAnswer`).
   */
  constrainedChoice?: boolean;
}

export interface ClaimFillResult {
  calls: NormalizedCall[];
  /**
   * Первая ошибка СРЕДЫ (не модели) из пачки, если была — тем же приёмом, что
   * `FormFillExecutor.noteEnvFailure`. До батчинга (трек 2) исключение `provider.chat()`
   * пробрасывалось из `fillClaims` наружу нетронутым, и вызывающий (`Run.ts`) ловил его
   * специально помеченным `ProviderEnvError`, отличая «сервер недоступен» от «модель
   * не ответила». `Promise.allSettled` эту метку внутри пачки гасит молча — здесь она
   * возвращается вызывающему явным полем, а не тонет вместе с остальными причинами отказа.
   */
  envFailure: string | null;
}

/** Ответ модели по одному пункту. `null` — разобрать не удалось. */
export function parseClaimAnswer(id: string, answer: string): NormalizedCall | null {
  const line = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'))
    .find((l) => l.includes('|'));
  if (line === undefined) return null;

  const [status = '', evidence = '', fix = ''] = line.split('|').map((p) => p.trim());
  // Разбор — через общий нормализатор: он один знает, что `passed`, `да` и `✅` это одно
  // и то же, и что пятой градации не бывает. Своя таблица статусов здесь разошлась бы
  // с той, по которой считается вердикт.
  const call = normalize('record_claim', {
    id,
    status,
    evidence,
    ...(fix === '' ? {} : { what_to_fix: fix }),
  });
  return call.kind === 'record_claim' ? call : null;
}

/**
 * Сколько пунктов приёмки группируются в ОДИН запрос (трек «сумма латентности»,
 * 2026-09-09). Замер (`docs/model-runs.md`): latency локальной модели без ручки
 * `reasoning_effort` почти не зависит от размера содержимого (~130 с что на тривиальном
 * вопросе, что на содержательном) — цена «размышления» платится ЗА ЗАПРОС, а не за объём.
 * Раньше 12 пунктов = 12 запросов (даже с параллельными пачками — сервер их всё равно
 * сериализовал, сумма латентности не падала). Группа держит число пунктов в одном ответе
 * разумным для слабой модели — не «всё сразу», а по образцу `REVIEW_PARALLEL` в
 * `reviewFill.ts` (тот же порядок величины, что уже проверен на осях).
 */
const CLAIM_GROUP = 6;

/** Один пункт приёмки внутри комбинированного вопроса. */
function claimBlock(n: number, claim: ClaimAsk, pack: string): string {
  return [
    `### ${n}. Пункт приёмки ${claim.id}`,
    '',
    claim.text,
    '',
    'Изменения, относящиеся к пункту:',
    '',
    '```diff',
    pack === '' ? '(правок, совпадающих с пунктом, не нашлось)' : pack,
    '```',
  ].join('\n');
}

/** Пояснение значений статуса и полей — общее для строчного и JSON-формата ответа. */
const FIELD_MEANING = [
  'СТАТУС — одно из: ✅ (доказано по diff или тестом), ❌ (опровергнуто), ' +
    '⚠ (доказательство держится на непройденной проверке), manual (пункт помечен ' +
    '[manual] в задаче человеком).',
  'ЧЕМ ПОДТВЕРЖДЁН — МЕСТО: `файл:символ`, имя теста или хунк. Не «проверено» и ' +
    'не «см. код»: ссылку сверяют с патчем.',
  'ЧТО ЧИНИТЬ — для не-зелёного статуса; для зелёного напиши `н/п`.',
];

function claimsCombinedQuestion(
  claims: readonly ClaimAsk[],
  packs: readonly string[],
  tests: string,
  constrainedChoice: boolean,
): string {
  const instruction = constrainedChoice
    ? [
        `Ответь JSON-объектом вида \`{"claims":[...]}\` — РОВНО ${claims.length} элементов, ` +
          'по одному на каждый пункт, каждый элемент:',
        '',
        '`{"id": "<id пункта>", "status": "<статус>", "evidence": "<чем подтверждён>", "what_to_fix": "<что чинить>"}`',
        '',
        ...FIELD_MEANING,
        'Кроме этого JSON, ничего не пиши.',
      ]
    : [
        `Ответь РОВНО ${claims.length} строками — по одной на каждый пункт, В ТОМ ЖЕ ПОРЯДКЕ, ` +
          'начиная с номера пункта:',
        '',
        '`N. СТАТУС | ЧЕМ ПОДТВЕРЖДЁН | ЧТО ЧИНИТЬ`',
        '',
        ...FIELD_MEANING,
        'Ничего, кроме этих строк, не пиши.',
      ];
  return [
    `## Проверь КАЖДЫЙ из ${claims.length} пунктов приёмки ниже`,
    '',
    ...claims.map((c, idx) => claimBlock(idx + 1, c, packs[idx] ?? '')),
    ...(tests.trim() === '' ? [] : ['', '## Что напечатал прогон тестов', '', '```', tests.trim().slice(-4000), '```']),
    '',
    ...instruction,
  ].join('\n');
}

/**
 * Разбор комбинированного ответа: строки `N. …`, N — порядковый номер пункта в ТОМ ЖЕ
 * запросе. Разбор одной строки делегирован `parseClaimAnswer` — второго места, знающего
 * форму ответа по пункту, не появляется.
 */
export function parseClaimsCombinedAnswer(
  claims: readonly ClaimAsk[],
  answer: string,
): { answeredIdx: Set<number>; calls: NormalizedCall[] } {
  const answeredIdx = new Set<number>();
  const calls: NormalizedCall[] = [];
  const lines = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'));
  for (const line of lines) {
    const m = /^(\d+)\.\s*(.*)$/.exec(line);
    if (m === null) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= claims.length || answeredIdx.has(idx)) continue;
    answeredIdx.add(idx);
    const rest = m[2] ?? '';
    if (rest.trim() === '') continue;
    const call = parseClaimAnswer(claims[idx]!.id, rest);
    if (call !== null) calls.push(call);
  }
  return { answeredIdx, calls };
}

/**
 * Разбор JSON-ответа группы (`constrainedChoice`): каждый элемент называет свой `id` сам,
 * поэтому сопоставление с пунктом — по `id`, а не по позиции в массиве, как у строчного
 * формата. `null` — ответ не JSON или не той формы (сервер проигнорировал `response_format`,
 * бывает не у всех провайдеров): вызывающий обязан упасть обратно на строчный разбор, а не
 * считать группу неотвеченной.
 */
export function parseClaimsJsonAnswer(
  claims: readonly ClaimAsk[],
  answer: string,
): { answeredIdx: Set<number>; calls: NormalizedCall[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const items = (parsed as Record<string, unknown>)['claims'];
  if (!Array.isArray(items)) return null;

  const idxById = new Map(claims.map((c, idx) => [c.id, idx]));
  const answeredIdx = new Set<number>();
  const calls: NormalizedCall[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : null;
    if (id === null) continue;
    const idx = idxById.get(id);
    if (idx === undefined || answeredIdx.has(idx)) continue;
    // Тот же нормализатор, что у строчного разбора: второго места, знающего форму
    // `record_claim`, не появляется. `evidence`/`what_to_fix` с символом `|` внутри JSON
    // не рвутся (в отличие от строчного `split('|')`) — само преимущество формата.
    const call = normalize('record_claim', rec);
    if (call.kind !== 'record_claim') continue;
    answeredIdx.add(idx);
    calls.push(call);
  }
  return { answeredIdx, calls };
}

/**
 * Спрашивает модель группами (`CLAIM_GROUP`) и возвращает разобранные записи.
 *
 * Группами, а не по одному (трек «сумма латентности», 2026-09-09): `signal.aborted`
 * проверяется перед КАЖДОЙ группой, а не перед каждым пунктом внутри нее. Упавший запрос
 * не превращается в отвеченный: вся группа останется незаполненной и честно уронит
 * вердикт — тем же приёмом, что уже описан в докстринге модуля («это не решение за
 * модель»).
 */
export async function fillClaims(i: ClaimFillInput): Promise<ClaimFillResult> {
  const hunks = splitHunks(i.diff);
  const out: NormalizedCall[] = [];
  let envFailure: string | null = null;

  const ask = (content: string, params: Record<string, unknown> | null) =>
    i.provider.chat({
      model: i.model,
      messages: [
        { role: 'system', content: i.system },
        { role: 'user', content },
      ],
      tools: [],
      signal: i.signal,
      temperature: null,
      params,
    });

  const constrained = i.constrainedChoice === true;

  for (let start = 0; start < i.claims.length; start += CLAIM_GROUP) {
    if (i.signal.aborted) break;
    const group = i.claims.slice(start, start + CLAIM_GROUP);
    const packs = group.map((claim) => packForClaim(claim.text, hunks, i.evidenceBudgetBytes));
    const params = constrained
      ? withResponseFormat(i.params, claimsSchema(group.map((c) => c.id)))
      : i.params;
    let response: Awaited<ReturnType<typeof ask>>;
    try {
      response = await ask(claimsCombinedQuestion(group, packs, i.tests, constrained), params);
    } catch (e) {
      if (envFailure === null && e instanceof ProviderEnvError) envFailure = e.message;
      const why = e instanceof Error ? e.message : String(e);
      i.onProgress?.(`группа пунктов ${group.map((c) => c.id).join(', ')} не отвечена: ${why}`);
      continue;
    }
    i.onUsage?.(response.usage);
    // Сервер мог проигнорировать `response_format` (не все провайдеры его понимают) —
    // `null` от JSON-разбора падает обратно на строчный формат, а не считает группу
    // неотвеченной.
    const parsed = constrained ? parseClaimsJsonAnswer(group, response.text) : null;
    const { answeredIdx, calls } = parsed ?? parseClaimsCombinedAnswer(group, response.text);
    out.push(...calls);
    if (answeredIdx.size < group.length) {
      i.onProgress?.(`ответ по группе пунктов неполон: разобрано ${answeredIdx.size} из ${group.length}`);
    }
  }

  return { calls: out, envFailure };
}
