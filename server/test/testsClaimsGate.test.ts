/**
 * Гейт «Сверка тестов с claims» — порт `tests_claims.py`: каждая добавленная тестовая
 * декларация несёт существующий `claim-N` в имени, теге или строке над ней; иначе ❌.
 * Кейсы — те же, что в посевах методологии (`test/test_gates.py`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtinFor } from '../src/gates/builtin/index.ts';
import { checkTestsClaims } from '../src/gates/builtin/testsClaims.ts';

function patch(path: string, added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1,${added.length + 1} @@`,
    ' x',
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

describe('гейт «Сверка тестов с claims»', () => {
  it('зарегистрирован под именем перечня', () => {
    ok(builtinFor('Сверка тестов с claims') !== null);
  });

  it('тест без id и тест с несуществующим id — находки; тест с id — в карте', () => {
    const r = checkTestsClaims(
      patch('tests/test_app.py', ['def test_claim_1_ok():', '    pass', 'def test_unlabeled():', '    pass', 'def test_claim_9_ghost():', '    pass']),
      new Set(['claim-1']),
    );
    deepStrictEqual(r.without, ['tests/test_app.py:4 — test_unlabeled']);
    deepStrictEqual(r.unknown, ['tests/test_app.py:6 — test_claim_9_ghost → claim-9 нет в задаче']);
    deepStrictEqual([...r.mapping.entries()], [['claim-1', ['test_claim_1_ok']], ['claim-9', ['test_claim_9_ghost']]]);
  });

  it('JUnit: @Tag("claim-N") после @Test и имя метода из сигнатуры', () => {
    const r = checkTestsClaims(
      patch('src/test/java/AppTest.java', ['@Test', '@Tag("claim-2")', 'void roundsHalfUp() {', '}']),
      new Set(['claim-2']),
    );
    deepStrictEqual(r.without, []);
    deepStrictEqual([...r.mapping.entries()], [['claim-2', ['roundsHalfUp']]]);
  });

  it('jest: it("claim-3: …") и комментарий строкой выше', () => {
    const r = checkTestsClaims(
      patch('src/a.test.ts', ['// claim-4', "it('handles empty input', () => {});", "it('claim-3: rounds', () => {});"]),
      new Set(['claim-3', 'claim-4']),
    );
    deepStrictEqual(r.without, []);
    strictEqual(r.mapping.size, 2);
  });

  it('патч без новых тестов — нарушений нет', () => {
    const r = checkTestsClaims(patch('src/app.ts', ['export const x = 1;']), new Set(['claim-1']));
    deepStrictEqual(r.without, []);
    strictEqual(r.mapping.size, 0);
  });
});
