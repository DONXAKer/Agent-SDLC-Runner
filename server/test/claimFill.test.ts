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

import { packForClaim, splitHunks } from '../src/run/claimEvidence.ts';
import { parseClaimAnswer } from '../src/run/claimFill.ts';

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
