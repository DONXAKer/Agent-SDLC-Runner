import test from 'node:test';
import assert from 'node:assert/strict';
import { autofillGuidedHandoff } from '../src/run/guidedHandoff.ts';

const current = ['## Виток 2 — 2026-10-05',
  '- **Предыдущая передача по этой задаче:** ‹ссылка или файл›',
  '- **Приёмка:** принял ‹имя› · ‹дата›', '', '## Готовность',
  '- Пункты в `❌`: ‹id› · Пункты в `⚠`: ‹id›',
  '- **Пункты `[manual]` — открытая ручная проверка** (не проверялись этим этапом,',
  '  не роняли `passed`): ‹id› / ни одного', '',
  '| Гейт | Статус |', '|---|---|', '| неверное имя | ✅ |', '',
  '## Наблюдения витка', "- Возвратов на этом chunk'е: ‹K−1›",
  "- Пункты, закрытые не тестом, а diff'ом: ‹id› / ни один", ''].join('\n');
const facts = { loop: 2, attempt: 3,
  gates: [{ name: 'Тесты', status: '✅' }, { name: 'Review', status: '⏭' }, { name: 'Scope', status: '❌' }],
  claims: [{ id: 'claim-1', status: '✅' as const, evidence: 'test/one.test.ts', whatToFix: null },
    { id: 'claim-2', status: '✅' as const, evidence: 'src/a.ts:method', whatToFix: null },
    { id: 'claim-3', status: '⚠' as const, evidence: 'src/b.ts', whatToFix: null }] };
test('handoff copies every exact gate status and current attempt facts without signing acceptance', () => {
  const previous = '## Виток 1 — 2026-10-04\n- **Приёмка:** Иван · 2026-10-04\n\n';
  const result = autofillGuidedHandoff(previous + current, facts);
  assert.ok(result.startsWith(previous));
  assert.ok(result.includes('handoff.md, секция витка 1'));
  assert.ok(result.includes('| Review | ⏭ |'));
  assert.ok(result.includes('| Scope | ❌ |'));
  assert.ok(!result.includes('неверное имя'));
  assert.ok(result.includes("Возвратов на этом chunk'е: 2"));
  assert.ok(result.includes("diff'ом: claim-2"));
  assert.ok(result.includes('Пункты в `⚠`: claim-3'));
  assert.ok(result.includes('- **Приёмка:** принял ‹имя› · ‹дата›'));
  assert.equal(autofillGuidedHandoff(result, facts), result);
});
test('first handoff states the absence of an earlier loop from the real loop count', () => {
  assert.ok(autofillGuidedHandoff(current, { ...facts, loop: 1 }).includes('нет — это первый виток'));
});

const defect = '\n## Запись о проскочившем дефекте\n- **Кто утвердил:** ‹имя›\n- Какой гейт пропустил: ‹гейт›\n';
test('handoff preserves caught Verify findings without inventing an escaped defect or signing acceptance', () => {
  const history = [{ path: '.runner/attempt-1.review.json', findings: ['Ненужная проверка qty; src/issue.ts:12'] }];
  const result = autofillGuidedHandoff(current + defect, { ...facts, reviewHistory: history });
  assert.ok(result.includes('Ненужная проверка qty; src/issue.ts:12'));
  assert.ok(result.includes(history[0]!.path));
  assert.ok(result.includes('не зарегистрирована'));
  assert.ok(!result.includes('‹гейт›'));
  assert.ok(result.includes('принял ‹имя› · ‹дата›'));
  assert.equal(autofillGuidedHandoff(result, { ...facts, reviewHistory: history }), result);
});
test('handoff leaves escaped defect records intact when history is unavailable, uncovered, or signed', () => {
  assert.ok(autofillGuidedHandoff(current + defect, facts).endsWith(defect));
  assert.ok(autofillGuidedHandoff(current + defect, { ...facts,
    reviewHistory: [{ path: 'review.json', findings: ['Поведение ограничения не покрыто тестом'] }] }).endsWith(defect));
  const signed = defect.replace('‹имя›', 'Иван · 2026-10-05');
  assert.ok(autofillGuidedHandoff(current + signed, { ...facts, reviewHistory: [] }).endsWith(signed));
});
