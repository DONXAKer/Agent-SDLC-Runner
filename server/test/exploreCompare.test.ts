/**
 * Предсортировка двух приёмочных листов (`explore/compare.ts`) и рендер в отчёт разведки.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionLabelsIn } from '../src/artifacts/artifact.ts';
import { compareClaims, renderClaimsComparison, renderClaimsNa, reverseGaps, similarity } from '../src/explore/compare.ts';
import type { BlindClaim } from '../src/run/claimsBlind.ts';

const author = [
  { id: 'claim-1', text: 'доставка для gold в ступени 3 бесплатна: total равен 0' },
  { id: 'claim-2', text: 'скидка лояльности продолжает считаться как считалась' },
  { id: 'claim-3', text: 'существующие тесты остаются зелёными без правки' },
];
const notDoing = ['- не меняем порядок применения скидки лояльности', '- не трогаем единицы и зоны'];

const claim = (n: number, text: string, check = 'тест'): BlindClaim => ({ n, text, check, tags: [] });

const REPORT = [
  '# Отчёт разведки: демо',
  '',
  '## Приёмочный лист, выведенный независимо',
  '_легенда_',
  '',
  '| # | Выведенное утверждение | Есть у автора |',
  '|---|---|---|',
  '| 1 | ‹утверждение› | да / **нет — кандидат в пропуск** / вне scope — противоречит «‹строка из „Чего не делаем“›» |',
  '',
  '**Расхождение:** ‹что есть у автора и нет здесь; что здесь и нет у автора› / списки совпали /',
  'н/п — второго измерения не было',
  '',
  '**Решение человека о полноте:** ‹лист полон / пропуск найден: что именно› — ‹имя›',
  '',
  '## Точка правки',
  '- ‹путь› — ‹почему›',
  '',
].join('\n');

describe('похожесть строк', () => {
  it('терпима к окончаниям: «доставка бесплатна» ≈ «считает доставку бесплатной»', () => {
    const s = similarity('доставка бесплатна', 'система считает доставку бесплатной');
    ok(s.score >= 0.5, `score ${s.score}`);
  });
});

describe('предсортировка', () => {
  it('совпало / кандидат / вне scope', () => {
    const compared = compareClaims(
      [claim(1, 'для gold в ступени 3 доставка бесплатна, total равен 0'), claim(2, 'порог silver задан явно'), claim(3, 'порядок применения скидки лояльности не меняется')],
      author,
      notDoing,
    );
    deepStrictEqual(compared[0]!.verdict, { kind: 'author', id: 'claim-1' });
    deepStrictEqual(compared[1]!.verdict, { kind: 'candidate' });
    strictEqual(compared[2]!.verdict.kind, 'outOfScope');
  });

  it('обратное расхождение: у автора есть, у агента нет', () => {
    const gaps = reverseGaps(author, [claim(1, 'для gold в ступени 3 доставка бесплатна, total равен 0')]);
    deepStrictEqual(gaps.map((g) => g.id), ['claim-2', 'claim-3']);
  });
});

describe('рендер в отчёт', () => {
  it('таблица заменяет образец, «Расхождение» заполнено, решение человека не тронуто', () => {
    const compared = compareClaims([claim(1, 'для gold в ступени 3 доставка бесплатна, total равен 0'), claim(2, 'порог silver задан явно | значение')], author, notDoing);
    const out = renderClaimsComparison(REPORT, compared, reverseGaps(author, compared.map((c) => c.claim)));
    ok(out.includes('| 1 | для gold в ступени 3 доставка бесплатна, total равен 0 — тест | да (claim-1) |'), out);
    ok(out.includes('**нет — кандидат в пропуск**'));
    ok(!out.includes('‹утверждение›'), 'образец остался');
    ok(out.includes('**Расхождение:** у агента есть, у автора нет: 1'), out);
    ok(!out.includes('н/п — второго измерения не было'), 'вторая строка меню осталась');
    ok(out.includes('**Решение человека о полноте:** ‹лист полон'), 'решение человека затронуто');
    deepStrictEqual(decisionLabelsIn(out), decisionLabelsIn(REPORT));
    ok(out.includes('## Точка правки\n- ‹путь› — ‹почему›'), 'соседняя секция повреждена');
  });

  it('без второго измерения: таблица заменена строкой н/п', () => {
    const out = renderClaimsNa(REPORT, 'гейт в долге');
    ok(out.includes('н/п — гейт в долге'));
    ok(!out.includes('| # | Выведенное утверждение'), 'таблица не удалена');
    ok(out.includes('**Расхождение:** н/п — второго измерения не было'));
    ok(out.includes('**Решение человека о полноте:** ‹лист полон'));
  });

  it('повторный проход по уже заполненной строке «Расхождение» переписывает её, а не молчит', () => {
    const first = renderClaimsComparison(REPORT, compareClaims([claim(1, 'A')], author, notDoing), []);
    ok(first.includes('**Расхождение:** у агента есть, у автора нет: 1'), first);
    const second = renderClaimsComparison(first, compareClaims([claim(1, 'для gold в ступени 3 доставка бесплатна, total равен 0')], author, notDoing), []);
    ok(second.includes('**Расхождение:** списки совпали'), second);
    ok(!second.includes('у агента есть, у автора нет: 1'), 'старое значение пережило перезапись');
  });
});
