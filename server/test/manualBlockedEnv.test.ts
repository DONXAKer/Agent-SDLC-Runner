/**
 * Две находки ретро 2026-08-27, которых не было в раннере: `manual` и `blocked_env`.
 *
 * M2: пункт с тегом `[manual]` по методологии не проверяется этапом 6 и вердикт не роняет —
 * разбор отчёта не знал этого слова, ставил `⚠` и краснел ровно на том пункте, который
 * освобождён от автоматики.
 *
 * M1: `blocked_env` описан в `SDLC.md` как отдельный исход («красный из-за окружения»), но
 * действия такого не было: гейт, не сумевший ЗАПУСТИТЬСЯ, давал обычный красный и съедал
 * номер попытки из бюджета.
 *
 * B1-класс: идентификатор пункта берётся из ячейки, а теги задачи (`[edge]`) — часть текста,
 * а не имени. Пока id брался целиком, `claim-4 [edge]` и `claim-4` были разными пунктами.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGates } from '../src/gates/gatesFile.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';
import type { VerdictInput } from '@sdlc-runner/shared';

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    gates: [],
    claims: [],
    confirmedReviewFindings: 0,
    enabledGatesMissingFromReport: [],
    openDebtRows: [],
    brokenInvariants: [],
    regressions: [],
    plannedPathsUntouched: [],
    diffMatchesTree: true,
    attempt: 1,
    attemptBudget: 3,
    noProgress: false,
    ...over,
  };
}

describe('пункт приёмки manual', () => {
  it('не роняет вердикт и не даёт причины', () => {
    const v = computeVerdict(input({ claims: [{ id: 'claim-3', status: 'manual' }] }), []);
    strictEqual(v.passed, true);
    deepStrictEqual(
      v.reasons.filter((r) => r.includes('claim-3')),
      [],
    );
  });

  it('⚠ по-прежнему роняет — разница между ними именно в этом', () => {
    const v = computeVerdict(input({ claims: [{ id: 'claim-3', status: '⚠' }] }), []);
    strictEqual(v.passed, false);
  });
});

describe('красный из-за окружения', () => {
  const blocked = { name: 'Тесты', status: '⏭' as const, inapplicableSignedBy: null, envBlocked: true };

  it('гейт, не сумевший запуститься, даёт blocked_env, а не retry', () => {
    const v = computeVerdict(input({ gates: [blocked] }), []);
    strictEqual(v.passed, false);
    strictEqual(v.action, 'blocked_env');
  });

  it('рядом с настоящим провалом это обычный красный: чинить есть что', () => {
    const v = computeVerdict(
      input({
        gates: [blocked, { name: 'Сборка', status: '❌', inapplicableSignedBy: null, envBlocked: false }],
      }),
      [],
    );
    strictEqual(v.action, 'retry');
  });

  it('опровергнутый пункт приёмки перебивает окружение', () => {
    const v = computeVerdict(
      input({ gates: [blocked], claims: [{ id: 'claim-1', status: '❌' }] }),
      [],
    );
    strictEqual(v.action, 'retry');
  });

  it('подписанная неприменимость снимает признак окружения', () => {
    const v = computeVerdict(
      input({ gates: [{ ...blocked, inapplicableSignedBy: 'Gritsay Aleksey' }] }),
      [],
    );
    strictEqual(v.action, 'continue');
    strictEqual(v.passed, true);
  });
});

/**
 * Принятый риск без условия возврата (находка F6 ретро 2026-08-27: одна такая строка
 * переехала через четыре витка, и условие возврата к тому моменту уже наступило).
 */
describe('долг: принятый риск обязан назвать, когда к нему вернуться', () => {
  const gates = (how: string): string =>
    [
      '# Набор',
      '',
      '## Набор',
      '',
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Линт экосистемы | нет | этап 6 | н/п — долг |',
      '',
      '## Долг',
      '',
      '| Гейт | Где должен стоять | Как закрывается | Дата | Кто |',
      '|---|---|---|---|---|',
      `| Линт экосистемы | этап 6 | ${how} | 2026-08-28 | Иван Петров |`,
      '',
    ].join('\n');

  it('риск без условия возврата закрытым не считается', () => {
    const g = parseGates(gates('риск принят: линтера нет'));
    strictEqual(g.debt[0]?.closed, false);
    ok(g.debt[0]!.why.includes('когда к нему вернуться'), g.debt[0]!.why);
  });

  it('риск с условием возврата закрыт', () => {
    const g = parseGates(gates('риск принят: линтера нет, вернуться при втором разработчике'));
    strictEqual(g.debt[0]?.closed, true);
  });

  it('ручная проверка условия возврата не требует', () => {
    const g = parseGates(gates('проверяет руками: глазами по diff перед коммитом'));
    strictEqual(g.debt[0]?.closed, true);
  });
});
