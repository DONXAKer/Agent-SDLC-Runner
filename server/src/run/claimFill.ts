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
 * Пачка параллельных вопросов — тот же приём, что `REVIEW_PARALLEL` в `reviewFill.ts`
 * (`FormFillExecutor.FIELD_PARALLEL`). Число подбирается тем же живым замером трека 2
 * (docs/model-runs.md), что и `REVIEW_PARALLEL` — независимо, «одна ручка на замер» не
 * запрещает две РАЗНЫЕ ручки в одной серии, если каждая мерится своим прогоном.
 */
const CLAIM_PARALLEL = 3;

/**
 * Спрашивает модель по каждому пункту и возвращает разобранные записи.
 *
 * Пачками (трек 2, 2026-09-09): `signal.aborted` проверяется перед КАЖДОЙ пачкой, а не
 * перед каждым пунктом внутри неё. Упавший запрос (`Promise.allSettled`) не превращается
 * в отвеченный: пункт останется незаполненным и честно уронит вердикт — тем же приёмом,
 * что уже описан в докстринге модуля («это не решение за модель»).
 */
export async function fillClaims(i: ClaimFillInput): Promise<ClaimFillResult> {
  const hunks = splitHunks(i.diff);
  const out: NormalizedCall[] = [];
  let envFailure: string | null = null;

  const ask = (claim: ClaimAsk) => {
    const pack = packForClaim(claim.text, hunks, i.evidenceBudgetBytes);
    return i.provider.chat({
      model: i.model,
      messages: [
        { role: 'system', content: i.system },
        {
          role: 'user',
          content: [
            `## Пункт приёмки ${claim.id}`,
            '',
            claim.text,
            '',
            '## Изменения, относящиеся к пункту',
            '',
            '```diff',
            pack === '' ? '(правок, совпадающих с пунктом, не нашлось)' : pack,
            '```',
            ...(i.tests.trim() === ''
              ? []
              : ['', '## Что напечатал прогон тестов', '', '```', i.tests.trim().slice(-4000), '```']),
            '',
            'Ответь ОДНОЙ строкой в формате:',
            '',
            '`СТАТУС | ЧЕМ ПОДТВЕРЖДЁН | ЧТО ЧИНИТЬ`',
            '',
            'СТАТУС — одно из: ✅ (доказано по diff или тестом), ❌ (опровергнуто), ' +
              '⚠ (доказательство держится на непройденной проверке), manual (пункт помечен ' +
              '[manual] в задаче человеком).',
            'ЧЕМ ПОДТВЕРЖДЁН — МЕСТО: `файл:символ`, имя теста или хунк. Не «проверено» и ' +
              'не «см. код»: ссылку сверяют с патчем.',
            'ЧТО ЧИНИТЬ — для не-зелёного статуса; для зелёного напиши `н/п`.',
            'Ничего, кроме этой строки, не пиши.',
          ].join('\n'),
        },
      ],
      tools: [],
      signal: i.signal,
      temperature: null,
      params: i.params,
    });
  };

  for (let batchStart = 0; batchStart < i.claims.length; batchStart += CLAIM_PARALLEL) {
    if (i.signal.aborted) break;
    const batch = i.claims.slice(batchStart, batchStart + CLAIM_PARALLEL);
    const answers = await Promise.allSettled(batch.map((claim) => ask(claim)));
    for (const [idx, claim] of batch.entries()) {
      const a = answers[idx]!;
      if (a.status !== 'fulfilled') {
        if (envFailure === null && a.reason instanceof ProviderEnvError) envFailure = a.reason.message;
        const why = a.reason instanceof Error ? a.reason.message : String(a.reason);
        i.onProgress?.(`пункт ${claim.id} не отвечен: ${why}`);
        continue;
      }
      i.onUsage?.(a.value.usage);
      const call = parseClaimAnswer(claim.id, a.value.text);
      if (call !== null) out.push(call);
    }
  }

  return { calls: out, envFailure };
}
