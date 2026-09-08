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
import { fillClaims, parseClaimAnswer } from '../src/run/claimFill.ts';

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

describe('добор пачками (трек 2)', () => {
  const claims = [1, 2, 3, 4].map((n) => ({ id: `claim-${n}`, text: `пункт ${n}` }));

  it('CLAIM_PARALLEL = 3: упавший запрос в пачке не топит соседей, ответившие рядом — не потеряны', async () => {
    let n = 0;
    const provider = {
      name: 'stub',
      async chat() {
        n++;
        if (n === 2) throw new Error('ollama: ответ не получен');
        return {
          text: '✅ | src/tariffs.ts:priceFor | н/п',
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
    // 4 пункта: пачка 1 = [1,2,3] (2-й падает → не отвечен), пачка 2 = [4].
    strictEqual(out.length, 3);
    ok(out.every((c) => c.kind === 'record_claim'));
    deepStrictEqual(
      out.map((c) => c.kind === 'record_claim' && c.id),
      ['claim-1', 'claim-3', 'claim-4'],
    );
    // Обычный Error (не ProviderEnvError) — не помечается как отказ среды.
    strictEqual(envFailure, null);
    ok(notes.some((m) => m.includes('claim-2') && m.includes('не отвечен')));
  });

  it('ProviderEnvError из пачки возвращается полем envFailure, а не тонет в Promise.allSettled', async () => {
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

  it('отмена останавливает добор перед следующей пачкой, не откатывая пришедшие ответы текущей', async () => {
    const ctl = new AbortController();
    const provider = {
      name: 'stub',
      async chat() {
        ctl.abort();
        return {
          text: '✅ | src/tariffs.ts:priceFor | н/п',
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
    // Пачка 1 = [1,2,3] уже запущена к моменту первого abort() — все трое отвечают;
    // пачка 2 = [4] не начинается вовсе.
    strictEqual(out.length, 3);
  });
});
