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

import type { NormalizedCall } from '@sdlc-runner/shared';

import { normalize } from '../exec/normalize.ts';
import type { ChatProvider } from '../provider/ChatProvider.ts';
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
 * Спрашивает модель по каждому пункту и возвращает разобранные записи.
 *
 * Последовательно, а не пачкой: локальный сервер всё равно исполняет запросы по одному,
 * а отмена между пунктами обязана останавливать добор — иначе «отменить» тратило бы
 * бюджет до последнего пункта.
 */
export async function fillClaims(i: ClaimFillInput): Promise<NormalizedCall[]> {
  const hunks = splitHunks(i.diff);
  const out: NormalizedCall[] = [];

  for (const claim of i.claims) {
    if (i.signal.aborted) break;
    const pack = packForClaim(claim.text, hunks, i.evidenceBudgetBytes);

    const answer = await i.provider.chat({
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

    const call = parseClaimAnswer(claim.id, answer.text);
    if (call !== null) out.push(call);
  }

  return out;
}
