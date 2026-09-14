/**
 * Механические поля плана, готовности и отчётов этапов 2–3 — рантаймом, и модель их
 * больше не спрашивается. Герметичные кейсы плюс скрепа по реальным шаблонам эталона:
 * поле, объявленное за рантаймом и исключённое из вопросов модели, обязано закрываться
 * автозаполнением — иначе оно осталось бы плейсхолдером, закрыть который некому.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deriveSchema } from '../src/artifacts/formSchema.ts';
import { loadConfig } from '../src/config/load.ts';
import { groupFields, modelGroupFields } from '../src/exec/FormFillExecutor.ts';
import { autofillPlan, autofillReadiness, autofillTitle } from '../src/run/formAutofill.ts';

const PLAN = [
  '# План: ‹название витка›',
  '',
  '- **Задача:** `intent.md` (‹название витка›)',
  '- **Вход:** отчёт разведки ‹да/нет› · отчёт по вопросам ‹да / шага не было›',
  '- **База:** ‹base_sha — коммит, от которого пойдёт diff›',
  '- **Одобрение:** ‹имя› · ‹дата› / **не одобрен — этап 5 не начинается**',
  '',
  '## Подход',
  '',
  '‹подход›',
  '',
  '| Ось | Затронута |',
  '|---|---|',
  '| ‹имя оси› | ‹да/нет› |',
  '',
].join('\n');

describe('autofillPlan', () => {
  const facts = { title: 'demo', explorationDone: true, clarificationDone: false, base: 'abc123' };

  it('закрывает название, вход и базу; решение человека, подход и таблицу осей не трогает', () => {
    const { text, filled } = autofillPlan(PLAN, facts);
    strictEqual(filled, 5);
    ok(text.includes('# План: demo'), text);
    ok(text.includes('отчёт разведки да · отчёт по вопросам шага не было'), text);
    ok(text.includes('- **База:** abc123'), text);
    ok(text.includes('- **Одобрение:** ‹имя› · ‹дата›'), 'решение человека обязано остаться нетронутым');
    ok(text.includes('‹подход›'));
    ok(text.includes('| ‹имя оси› | ‹да/нет› |'), '«да/нет» в таблице осей — выбор модели, не факт рантайма');
  });

  it('идемпотентно', () => {
    const once = autofillPlan(PLAN, facts).text;
    deepStrictEqual(autofillPlan(once, facts), { text: once, filled: 0 });
  });
});

describe('autofillReadiness', () => {
  const READINESS = [
    '# Готовность задачи: ‹название витка›',
    '',
    '## Прогон 1 — перед разведкой',
    '',
    '- **Дата:** ‹дата›',
    '',
    '## Прогон 2 — перед планом',
    '',
    '- **Дата:** ‹дата›',
    '',
  ].join('\n');

  it('этап intent ставит дату прогона 1 и не трогает дату прогона 2', () => {
    const { text } = autofillReadiness(READINESS, { title: 'demo', date: '2026-09-14', run: 1 });
    ok(text.startsWith('# Готовность задачи: demo'), text);
    const [run1, run2] = text.split('## Прогон 2');
    ok(run1!.includes('**Дата:** 2026-09-14'), text);
    ok(run2!.includes('**Дата:** ‹дата›'), text);
  });

  it('этап plan ставит дату прогона 2', () => {
    const afterIntent = autofillReadiness(READINESS, { title: 'demo', date: '2026-09-14', run: 1 }).text;
    const { text, filled } = autofillReadiness(afterIntent, { title: 'demo', date: '2026-09-15', run: 2 });
    strictEqual(filled, 1);
    ok(text.split('## Прогон 2')[1]!.includes('**Дата:** 2026-09-15'), text);
  });
});

describe('modelGroupFields', () => {
  it('поля рантайма плана модели не отдаются; содержательные и решения — как прежде', () => {
    const path = '/p/.sdlc/demo/plan.md';
    const all = groupFields(PLAN).map((g) => g.text);
    const asked = modelGroupFields(PLAN, path).map((g) => g.text);
    ok(all.some((t) => t.startsWith('‹base_sha')), JSON.stringify(all));
    ok(!asked.some((t) => t.startsWith('‹base_sha')), JSON.stringify(asked));
    ok(asked.includes('‹подход›'), JSON.stringify(asked));
  });

  it('шаблон вне покрытого набора (журнал chunk’а) — без изменений: там закрыть поле некому', () => {
    const journal = '# Журнал chunk’а ‹N›: ‹название витка›\n\n- **База:** ‹base_sha›\n';
    deepStrictEqual(modelGroupFields(journal, '/p/.sdlc/demo/chunk-1-journal.md'), groupFields(journal));
  });
});

const methodologyDir = loadConfig().runner.methodologyDir;
const templatesDir = join(methodologyDir, 'templates');
const noTemplates = existsSync(templatesDir) ? false : 'эталон методологии недоступен (SDLC_METHODOLOGY_DIR)';

describe('скрепа: поля рантайма реальных шаблонов закрываются автозаполнением', { skip: noTemplates }, () => {
  const fill: Record<string, (t: string) => string> = {
    'plan.template.md': (t) => autofillPlan(t, { title: 'demo', explorationDone: true, clarificationDone: true, base: 'abc' }).text,
    'readiness.template.md': (t) =>
      autofillReadiness(autofillReadiness(t, { title: 'demo', date: '2026-09-14', run: 1 }).text, {
        title: 'demo',
        date: '2026-09-14',
        run: 2,
      }).text,
    'clarification-report.template.md': (t) => autofillTitle(t, 'demo').text,
    'exploration-report.template.md': (t) => autofillTitle(t, 'demo').text,
  };

  for (const [name, apply] of Object.entries(fill)) {
    it(`${name}: после автозаполнения ни одно поле рантайма не держит плейсхолдер`, () => {
      const filled = apply(readFileSync(join(templatesDir, name), 'utf8'));
      const leftovers = deriveSchema(filled, name)
        .fields.filter((f) => f.owner === 'runtime' || f.kind === 'mechanical')
        .filter((f) => filled.slice(f.range.start, f.range.end).includes('‹'))
        .map((f) => f.id);
      deepStrictEqual(leftovers, []);
    });
  }
});
