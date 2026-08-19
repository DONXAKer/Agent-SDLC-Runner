/**
 * Классификация причин красного вердикта.
 *
 * По одному входу на каждый вид причины плюс смешанные: правило «самая ранняя по витку
 * побеждает» существует ради смешанного случая, а он и есть обычный.
 *
 * Отдельная планка — классификатор не имеет права влиять на `passed`. Проверяется прямо:
 * `computeVerdict` на том же входе остаётся красным при любой классификации.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VerdictInput } from '@sdlc-runner/shared';

import { classifyRedVerdict } from '../src/verdict/classify.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    gates: [{ name: 'Сборка', status: '✅', inapplicableSignedBy: null }],
    claims: [{ id: 'claim-1', status: '✅' }],
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

const redGate = (name: string): VerdictInput['gates'] => [
  { name, status: '❌', inapplicableSignedBy: null },
];

describe('классификация причин красного', () => {
  it('на зелёном входе не срабатывает', () => {
    strictEqual(classifyRedVerdict(input()), null);
  });

  it('упавшая «Сборка» — работа на том же этапе', () => {
    const c = classifyRedVerdict(input({ gates: redGate('Сборка') }));
    ok(c !== null);
    strictEqual(c.kind, 'gate');
    strictEqual(c.suggest, 'fix-in-chunk');
  });

  it('красный scope возвращает на план', () => {
    const c = classifyRedVerdict(input({ gates: redGate('Scope: файлы вне плана') }));
    ok(c !== null);
    strictEqual(c.kind, 'scope');
    strictEqual(c.suggest, 'back-to-plan');
  });

  it('имя гейта сравнивается через gateKey, а не дословно', () => {
    // Регистр, обратные кавычки и ё — набор гейтов пишет человек.
    const c = classifyRedVerdict(input({ gates: redGate('`SCOPE:  файлы вне плана`') }));
    ok(c !== null);
    strictEqual(c.kind, 'scope');
  });

  it('расхождение рецензента с прогоном — случай эскалации модели', () => {
    const c = classifyRedVerdict(input({ claims: [{ id: 'c', status: '❌' }] }), [
      'рецензент поставил ✅ гейту «Тесты», фактический прогон дал ❌',
    ]);
    ok(c !== null);
    strictEqual(c.kind, 'reviewer');
    strictEqual(c.suggest, 'escalate-model');
  });

  it('опровергнутый пункт приёмки — retry на том же этапе', () => {
    const c = classifyRedVerdict(input({ claims: [{ id: 'claim-2', status: '❌' }] }));
    ok(c !== null);
    strictEqual(c.kind, 'claim');
    strictEqual(c.suggest, 'fix-in-chunk');
  });

  it('нарушенный инвариант классифицируется отдельно от пунктов приёмки', () => {
    const c = classifyRedVerdict(input({ brokenInvariants: ['политика обойдена'] }));
    ok(c !== null);
    strictEqual(c.kind, 'integrity');
  });

  it('на смешанном входе побеждает scope, но обоснование называет обе причины', () => {
    const c = classifyRedVerdict(
      input({
        gates: [
          { name: 'Scope: файлы вне плана', status: '❌', inapplicableSignedBy: null },
          { name: 'Тесты', status: '❌', inapplicableSignedBy: null },
        ],
      }),
    );
    ok(c !== null);
    strictEqual(c.kind, 'scope');
    strictEqual(c.suggest, 'back-to-plan');
    ok(c.why.some((w) => w.includes('Scope')));
    ok(c.why.some((w) => w.includes('Тесты')));
    // Победившая причина идёт первой: оператор читает сверху.
    ok((c.why[0] ?? '').includes('Scope'));
  });

  it('неизвестный гейт трактуется как «чинить на том же этапе», а не игнорируется', () => {
    const c = classifyRedVerdict(input({ gates: redGate('Наш особый гейт') }));
    ok(c !== null);
    strictEqual(c.kind, 'gate');
    ok(c.why.some((w) => w.includes('Наш особый гейт')));
  });

  it('пропуск без подписанной неприменимости — тоже причина', () => {
    const c = classifyRedVerdict(
      input({ gates: [{ name: 'Тесты', status: '⏭', inapplicableSignedBy: null }] }),
    );
    ok(c !== null);
    strictEqual(c.kind, 'gate');
  });

  it('классификация не делает красный вердикт зелёным ни в одной ветке', () => {
    const cases = [
      input({ gates: redGate('Scope: файлы вне плана') }),
      input({ gates: redGate('Сборка') }),
      input({ claims: [{ id: 'c', status: '❌' }] }),
      input({ brokenInvariants: ['x'] }),
      input({ diffMatchesTree: false }),
    ];
    for (const i of cases) {
      strictEqual(computeVerdict(i).passed, false);
      ok(classifyRedVerdict(i) !== null);
    }
  });

  it('исчерпанный бюджет и отсутствие прогресса решает decideAction, а не классификатор', () => {
    const i = input({ gates: redGate('Сборка'), noProgress: true, attempt: 3, attemptBudget: 3 });
    strictEqual(computeVerdict(i).action, 'escalate');
    // Классификатор при этом по-прежнему отвечает «куда возвращать», не трогая action.
    deepStrictEqual(classifyRedVerdict(i)?.kind, 'gate');
  });
});
