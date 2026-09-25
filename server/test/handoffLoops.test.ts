/**
 * Handoff по виткам (`SDLC.md` → «Раскладка артефактов»): секции «## Виток K — дата»
 * сверху вниз, действует ПОСЛЕДНЯЯ «Приёмка»; закрытый виток — новая секция из формы, а не
 * переписанная; подпись рантайма ложится в последнюю секцию.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECISION, lastLoopSectionStart, loopSectionCount, readDecision, readLastDecision, setLastDecision } from '../src/artifacts/artifact.ts';
import { autofillHandoff } from '../src/run/formAutofill.ts';
import { appendLoopSection } from '../src/run/stages/handoff.ts';

const TEMPLATE = [
  '<!-- sdlc-template: handoff v1 -->',
  '# Передача контекста: ‹название витка›',
  '',
  '> шапка формы',
  '',
  '## Виток ‹K› — ‹дата›',
  '',
  '- **Задача:** ‹id›',
  '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
  '',
  '## Что сделано',
  '',
  '- ‹что сделано›',
  '',
].join('\n');

const LOOP1 = TEMPLATE.replace('‹K›', '1').replace('## Виток 1 — ‹дата›', '## Виток 1 — 2026-09-01').replace('принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**', 'Иван · 2026-09-01');

describe('handoff по виткам', () => {
  it('последняя «Приёмка» действует, первая — прошлого витка', () => {
    const two = `${LOOP1}\n## Виток 2 — 2026-09-24\n\n- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**\n`;
    strictEqual(loopSectionCount(two), 2);
    strictEqual(readDecision(two, DECISION.accepted).state, 'granted', 'первая — прошлого витка');
    strictEqual(readLastDecision(two, DECISION.accepted).state, 'placeholder');
    const signed = setLastDecision(two, DECISION.accepted, 'Пётр · 2026-09-24');
    strictEqual(readLastDecision(signed, DECISION.accepted).state, 'granted');
    ok(signed.slice(0, lastLoopSectionStart(signed)).includes('Иван · 2026-09-01'), 'первая секция не тронута');
  });

  it('закрытый виток — дописывается новая секция из формы; открытый — нет; старая форма — нет', () => {
    const next = appendLoopSection(LOOP1, TEMPLATE);
    ok(next !== null);
    strictEqual(loopSectionCount(next), 2);
    ok(next.endsWith('- ‹что сделано›\n'), next.slice(-40));
    ok(next.includes('## Виток ‹K› — ‹дата›'));
    strictEqual(appendLoopSection(TEMPLATE, TEMPLATE), null, 'открытая секция — тот же виток');
    strictEqual(appendLoopSection('# без секций\n\n- **Приёмка:** Иван · 2026-01-01\n', TEMPLATE), null);
  });

  it('автозаполнение ставит номер витка и дату в заголовок новой секции', () => {
    const next = appendLoopSection(LOOP1, TEMPLATE)!;
    const { text } = autofillHandoff(next, {
      title: 'demo',
      slug: 'demo',
      repo: 'r',
      branch: 'b',
      baseSha: 's',
      commit: 'c',
      gatesDate: 'd',
      chunk: 1,
      attempts: 1,
      verdict: 'passed',
      published: 'нет',
      publishGate: { status: '✅', branchOk: 'та', hasCommit: 'да', junk: 'нет' },
      loop: 2,
      date: '2026-09-24',
    });
    ok(text.includes('## Виток 2 — 2026-09-24'), text);
    ok(text.includes('## Виток 1 — 2026-09-01'));
  });
});
