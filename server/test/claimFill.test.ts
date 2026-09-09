/**
 * Поклаймовый добор этапа 6: срез патча под пункт и разбор ответа.
 *
 * Ручка заведена по той же причине, что `formFill` на этапах-документах: у дешёвой модели
 * порог «удержать линейную работу на 60 ходов» лежит ниже порога «разобрать один пункт по
 * срезу». Ревью она не заменяет — целый патч читает независимый рецензент, и находимость
 * по посеву (`bench --seed`) имеет право вето на эту ручку.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderEnvError, type ChatProvider } from '../src/provider/ChatProvider.ts';
import { packForClaim, splitHunks, topFileForClaim } from '../src/run/claimEvidence.ts';
import { fillClaims, parseClaimAnswer, parseClaimsCombinedAnswer } from '../src/run/claimFill.ts';

const DIFF = [
  'diff --git a/src/tariffs.ts b/src/tariffs.ts',
  '--- a/src/tariffs.ts',
  '+++ b/src/tariffs.ts',
  '@@ -10,3 +10,4 @@',
  '+  const surcharge = oversizeSurcharge(order.dimensionsCm, base);',
  'diff --git a/test/money.test.ts b/test/money.test.ts',
  '--- a/test/money.test.ts',
  '+++ b/test/money.test.ts',
  '@@ -1,2 +1,3 @@',
  '+it("округление половины вверх", () => {});',
].join('\n');

describe('нарезка патча', () => {
  it('режет по файлам, а не по @@: хунк без шапки бесполезен', () => {
    const hunks = splitHunks(DIFF);
    deepStrictEqual(
      hunks.map((h) => h.file),
      ['src/tariffs.ts', 'test/money.test.ts'],
    );
    ok(hunks[0]!.text.includes('oversizeSurcharge'));
  });

  it('пустой патч даёт пустую нарезку, а не одну пустую запись', () => {
    deepStrictEqual(splitHunks(''), []);
  });
});

describe('срез под пункт', () => {
  it('берёт хунк, совпадающий словами пункта', () => {
    const pack = packForClaim('надбавка surcharge считается от базы', splitHunks(DIFF), 10_000);
    ok(pack.includes('oversizeSurcharge'));
  });

  it('при совпадениях порядок воспроизводим: тот же вход — тот же срез', () => {
    const hunks = splitHunks(DIFF);
    const a = packForClaim('округление половины вверх', hunks, 10_000);
    const b = packForClaim('округление половины вверх', hunks, 10_000);
    strictEqual(a, b);
    ok(a.startsWith('diff --git a/test/money.test.ts'), a.slice(0, 60));
  });

  it('без единого совпадения срез НЕ пустой: пустая карта превращает вопрос в «ответь по памяти»', () => {
    const pack = packForClaim('нечто, чего в патче нет вовсе', splitHunks(DIFF), 10_000);
    ok(pack !== '');
  });

  it('потолок соблюдается, но хотя бы один хунк отдаётся всегда', () => {
    const pack = packForClaim('надбавка', splitHunks(DIFF), 10);
    ok(pack !== '');
    strictEqual(pack.includes('test/money.test.ts'), false);
  });

  it('topFileForClaim — файл ТОП хунка среза, не первый хунк всего патча', () => {
    // DIFF: первый хунк патча — src/tariffs.ts, второй — test/money.test.ts. Текст ниже
    // словами совпадает только со вторым — честный fallback обязан назвать ЕГО, а не
    // первый файл патча (была находка: `hunks[0]?.file` в reviewFill.ts игнорировал срез).
    strictEqual(topFileForClaim('округление половины вверх', splitHunks(DIFF)), 'test/money.test.ts');
    strictEqual(topFileForClaim('надбавка surcharge считается от базы', splitHunks(DIFF)), 'src/tariffs.ts');
  });
});

describe('разбор ответа по пункту', () => {
  it('строка «статус | место | что чинить» становится записью', () => {
    const call = parseClaimAnswer('claim-2', '✅ | src/tariffs.ts:priceFor | н/п');
    deepStrictEqual(call, {
      kind: 'record_claim',
      id: 'claim-2',
      status: '✅',
      evidence: 'src/tariffs.ts:priceFor',
      whatToFix: 'н/п',
    });
  });

  it('слово вместо значка принимается — разбор один на весь рантайм', () => {
    const call = parseClaimAnswer('claim-1', 'failed | test/a.test.ts | вернуть ставку 40%');
    strictEqual(call !== null && call.kind === 'record_claim' && call.status, '❌');
  });

  it('обёртки модели (```-блок, болтовня вокруг) не мешают', () => {
    const call = parseClaimAnswer('claim-3', '```\n⚠ | тест не запускался | прогнать тесты\n```');
    strictEqual(call !== null && call.kind === 'record_claim' && call.status, '⚠');
  });

  it('ответ без формата — null, а не выдуманный статус', () => {
    strictEqual(parseClaimAnswer('claim-4', 'думаю, всё в порядке'), null);
  });

  it('невнятный статус — null: пункт останется незаполненным и честно уронит вердикт', () => {
    strictEqual(parseClaimAnswer('claim-5', 'частично | где-то там | —'), null);
  });
});

describe('разбор комбинированного ответа по группе пунктов', () => {
  const claims = [1, 2, 3].map((n) => ({ id: `claim-${n}`, text: `пункт ${n}` }));

  it('строки «N. …» разбираются по номеру, порядок прихода не важен', () => {
    const answer = ['2. ❌ | test/a.test.ts | вернуть ставку', '1. ✅ | src/tariffs.ts:priceFor | н/п', '3. ⚠ | тест не запускался | прогнать'].join(
      '\n',
    );
    const { answeredIdx, calls } = parseClaimsCombinedAnswer(claims, answer);
    strictEqual(answeredIdx.size, 3);
    deepStrictEqual(
      calls.map((c) => c.kind === 'record_claim' && c.id).sort(),
      ['claim-1', 'claim-2', 'claim-3'],
    );
  });

  it('номер вне диапазона и дубль — отбрасываются, остальные пункты разбираются', () => {
    const answer = ['0. ✅ | x | н/п', '9. ✅ | x | н/п', '1. ✅ | src/tariffs.ts:priceFor | н/п', '1. ❌ | повтор | чинить'].join('\n');
    const { answeredIdx, calls } = parseClaimsCombinedAnswer(claims, answer);
    deepStrictEqual([...answeredIdx], [0]);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]!.kind === 'record_claim' && calls[0]!.status, '✅');
  });
});

describe('добор группами (трек «сумма латентности», 2026-09-09)', () => {
  const claims = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `claim-${n}`, text: `пункт ${n}` }));
  const combinedAnswer = (ids: number[]) => ids.map((n, i) => `${i + 1}. ✅ | src/tariffs.ts:priceFor | н/п`).join('\n');

  it('CLAIM_GROUP = 6: 8 пунктов — РОВНО 2 запроса (группами), не 8', async () => {
    const asked: string[] = [];
    const provider = {
      name: 'stub',
      async chat(req: { messages: { role: string; content: string }[] }) {
        const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
        asked.push(user);
        return {
          text: combinedAnswer([1, 2, 3, 4, 5, 6]),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const { calls: out } = await fillClaims({
      provider,
      model: 'stub',
      params: null,
      system: 'ты рецензент',
      claims,
      diff: DIFF,
      tests: '',
      evidenceBudgetBytes: 10_000,
      signal: new AbortController().signal,
    });
    strictEqual(asked.length, 2);
    ok(asked[0]!.includes('### 1. Пункт приёмки claim-1') && asked[0]!.includes('### 6. Пункт приёмки claim-6'));
    ok(asked[1]!.includes('### 1. Пункт приёмки claim-7') && asked[1]!.includes('### 2. Пункт приёмки claim-8'));
    // Группа 1 (6 пунктов) разбирает все 6 строк фиктивного ответа; группа 2 (claim-7,
    // claim-8 — те же 2 индекса) разбирает только первые 2 строки, остальные номера вне
    // диапазона группы и отбрасываются `parseClaimsCombinedAnswer`.
    strictEqual(out.length, 8);
  });

  it('упавший запрос топит ВСЮ группу (не отвечена), соседняя группа — нет', async () => {
    let n = 0;
    const provider = {
      name: 'stub',
      async chat() {
        n++;
        if (n === 1) throw new Error('ollama: ответ не получен');
        return {
          text: combinedAnswer([1, 2]),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const notes: string[] = [];
    const { calls: out, envFailure } = await fillClaims({
      provider,
      model: 'stub',
      params: null,
      system: 'ты рецензент',
      claims,
      diff: DIFF,
      tests: '',
      evidenceBudgetBytes: 10_000,
      signal: new AbortController().signal,
      onProgress: (m) => notes.push(m),
    });
    // Группа 1 (claim-1..6) падает целиком, группа 2 (claim-7, claim-8) отвечает — 2 записи.
    strictEqual(out.length, 2);
    strictEqual(envFailure, null);
    ok(notes.some((m) => m.includes('claim-1') && m.includes('не отвечена')));
  });

  it('ProviderEnvError возвращается полем envFailure, а не тонет молча', async () => {
    const provider = {
      name: 'stub',
      async chat() {
        throw new ProviderEnvError('ollama: ECONNREFUSED');
      },
    } as unknown as ChatProvider;
    const { calls: out, envFailure } = await fillClaims({
      provider,
      model: 'stub',
      params: null,
      system: 'ты рецензент',
      claims: claims.slice(0, 1),
      diff: DIFF,
      tests: '',
      evidenceBudgetBytes: 10_000,
      signal: new AbortController().signal,
    });
    strictEqual(out.length, 0);
    strictEqual(envFailure, 'ollama: ECONNREFUSED');
  });

  it('отмена останавливает добор перед следующей группой, не откатывая пришедший ответ текущей', async () => {
    const ctl = new AbortController();
    const provider = {
      name: 'stub',
      async chat() {
        ctl.abort();
        return {
          text: combinedAnswer([1, 2, 3, 4, 5, 6]),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const { calls: out } = await fillClaims({
      provider,
      model: 'stub',
      params: null,
      system: 'ты рецензент',
      claims,
      diff: DIFF,
      tests: '',
      evidenceBudgetBytes: 10_000,
      signal: ctl.signal,
    });
    // Группа 1 уже запущена к моменту abort() — отвечает; группа 2 не начинается вовсе.
    strictEqual(out.length, 6);
  });
});
