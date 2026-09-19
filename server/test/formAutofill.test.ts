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
import {
  RUNTIME_AUTOFILLED_TEMPLATES,
  autofillClarification,
  autofillHandoff,
  autofillPlan,
  autofillReadiness,
  autofillTitle,
} from '../src/run/formAutofill.ts';

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

describe('autofillClarification', () => {
  const CLARIFICATION = [
    '# Отчёт по вопросам: ‹название витка›',
    '',
    '- **Задача:** `intent.md`',
    '- **Разведка:** `exploration-report.md` / шага не было — мелкий контур',
    '',
    '## Вопросы',
    '',
    '‹вопрос›',
    '',
  ].join('\n');

  it('разведка была — ветка «exploration-report.md», название витка закрыто, содержательное не тронуто', () => {
    const { text, filled } = autofillClarification(CLARIFICATION, { title: 'demo', explorationDone: true });
    strictEqual(filled, 2);
    ok(text.includes('# Отчёт по вопросам: demo'), text);
    ok(text.includes('- **Разведка:** `exploration-report.md`\n'), text);
    ok(!text.includes('шага не было'), text);
    ok(text.includes('‹вопрос›'), 'содержательное поле — модели');
  });

  it('разведки не было — ветка «шага не было»', () => {
    const { text } = autofillClarification(CLARIFICATION, { title: 'demo', explorationDone: false });
    ok(text.includes('- **Разведка:** шага не было — мелкий контур\n'), text);
    ok(!text.includes('exploration-report.md'), text);
  });

  it('идемпотентно: выбранная ветка повторным вызовом не перетирается, даже с другим фактом', () => {
    const once = autofillClarification(CLARIFICATION, { title: 'demo', explorationDone: true }).text;
    deepStrictEqual(autofillClarification(once, { title: 'demo', explorationDone: true }), { text: once, filled: 0 });
    deepStrictEqual(autofillClarification(once, { title: 'demo', explorationDone: false }), { text: once, filled: 0 });
  });

  it('поля «Разведка» нет — только название витка', () => {
    const { text, filled } = autofillClarification('# Отчёт по вопросам: ‹название витка›\n', {
      title: 'demo',
      explorationDone: true,
    });
    deepStrictEqual({ text, filled }, { text: '# Отчёт по вопросам: demo\n', filled: 1 });
  });
});

describe('autofillHandoff', () => {
  const HANDOFF = [
    '# Передача контекста: ‹название витка›',
    '',
    '- **Задача:** ‹id или название — то же на всех витках этой задачи›',
    '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
    '',
    '## Состояние (машиночитаемое)',
    '',
    '```yaml',
    'slug: ‹slug›',
    'repo: ‹имя репозитория или remote URL›',
    'branch: ‹sdlc/слаг› # н/п если ветки нет',
    'base_sha: ‹sha›',
    "commit: ‹sha›        # н/п — коммита не было",
    'gates_date: ‹дата последнего изменения набора›',
    'chunk: ‹N›',
    "attempts: ‹K›        # из журнала chunk'а",
    'verdict: ‹passed/failed/aborted›',
    'published: ‹да/нет›',
    '```',
    '',
    '## Гейт «Проверка предусловий публикации»',
    '',
    '- Статус: ‹✅/❌/⏭ — гейт в долге› · ветка: ‹та / не та›; есть что коммитить: ‹да/нет›;',
    '  мусор в коммите: ‹нет / что именно›',
    '',
  ].join('\n');

  const facts = {
    title: 'demo',
    slug: 'demo',
    repo: 'git@github.com:acme/demo.git',
    branch: 'sdlc/demo',
    baseSha: 'abc123',
    commit: 'def456',
    gatesDate: '2026-09-18',
    chunk: 2,
    attempts: 3,
    verdict: 'passed' as const,
    published: 'нет' as const,
    publishGate: { status: '✅', branchOk: 'та', hasCommit: 'да', junk: 'нет' },
  };

  it('закрывает название, «Состояние» целиком и строку «Статус»; решение человека не трогает', () => {
    const { text, filled } = autofillHandoff(HANDOFF, facts);
    strictEqual(filled, 15);
    ok(text.includes('# Передача контекста: demo'), text);
    ok(text.includes('slug: demo'), text);
    ok(text.includes('repo: git@github.com:acme/demo.git'), text);
    ok(text.includes('branch: sdlc/demo'), text);
    ok(text.includes('base_sha: abc123'), text);
    ok(text.includes('commit: def456'), text);
    ok(text.includes('gates_date: 2026-09-18'), text);
    ok(text.includes('chunk: 2'), text);
    ok(text.includes('attempts: 3'), text);
    ok(text.includes('verdict: passed'), text);
    ok(text.includes('published: нет'), text);
    ok(text.includes('Статус: ✅ · ветка: та; есть что коммитить: да;'), text);
    ok(text.includes('мусор в коммите: нет'), text);
    ok(text.includes('- **Приёмка:** принял ‹имя›'), 'решение человека обязано остаться нетронутым');
  });

  it('base_sha и commit несут одинаковый текст плейсхолдера, но не путаются', () => {
    const { text } = autofillHandoff(HANDOFF, facts);
    ok(text.includes('base_sha: abc123'), text);
    ok(text.includes('commit: def456'), text);
  });

  it('«есть что коммитить» и `published` несут одинаковый текст плейсхолдера, но не путаются', () => {
    const { text } = autofillHandoff(HANDOFF, { ...facts, published: 'нет', publishGate: { ...facts.publishGate, hasCommit: 'да' } });
    ok(text.includes('есть что коммитить: да'), text);
    ok(text.includes('published: нет'), text);
  });

  it('идемпотентно', () => {
    const once = autofillHandoff(HANDOFF, facts).text;
    deepStrictEqual(autofillHandoff(once, facts), { text: once, filled: 0 });
  });

  it('реальный sha коммита — поясняющий комментарий шаблона «н/п — коммита не было» снимается', () => {
    // Регрессия ревью (2026-09-18): комментарий верен только пока значение н/п;
    // `fillMechanicalPlaceholders` трогает лишь `‹sha›`, и строка читалась самопротиворечиво
    // («commit: def456  # н/п — коммита не было»).
    const { text } = autofillHandoff(HANDOFF, facts);
    ok(text.includes('commit: def456'), text);
    ok(!text.includes('н/п — коммита не было'), text);
  });

  it('коммита не было (обрыв витка) — комментарий остаётся, он всё ещё верен', () => {
    const { text } = autofillHandoff(HANDOFF, { ...facts, commit: 'н/п — коммита не было' });
    ok(text.includes('commit: н/п — коммита не было'), text);
  });

  it('реальная ветка — поясняющий комментарий «н/п если ветки нет» снимается', () => {
    const { text } = autofillHandoff(HANDOFF, facts);
    ok(text.includes('branch: sdlc/demo'), text);
    ok(!text.includes('н/п если ветки нет'), text);
  });

  it('не git-репозиторий — комментарий у ветки остаётся, значение само н/п', () => {
    const { text } = autofillHandoff(HANDOFF, { ...facts, branch: 'н/п — не git-репозиторий' });
    ok(text.includes('branch: н/п — не git-репозиторий'), text);
    ok(text.includes('н/п если ветки нет'), text);
  });
});

describe('RUNTIME_AUTOFILLED_TEMPLATES', () => {
  it('набор покрытых шаблонов — ровно пять форм с автозаполнением этого файла', () => {
    deepStrictEqual([...RUNTIME_AUTOFILLED_TEMPLATES].sort(), [
      'clarification-report.template.md',
      'exploration-report.template.md',
      'handoff.template.md',
      'plan.template.md',
      'readiness.template.md',
    ]);
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
    'clarification-report.template.md': (t) => autofillClarification(t, { title: 'demo', explorationDone: true }).text,
    'exploration-report.template.md': (t) => autofillTitle(t, 'demo').text,
    'handoff.template.md': (t) =>
      autofillHandoff(t, {
        title: 'demo',
        slug: 'demo',
        repo: 'git@github.com:acme/demo.git',
        branch: 'sdlc/demo',
        baseSha: 'abc123',
        commit: 'def456',
        gatesDate: '2026-09-18',
        chunk: 1,
        attempts: 1,
        verdict: 'passed',
        published: 'нет',
        publishGate: { status: '✅', branchOk: 'та', hasCommit: 'да', junk: 'нет' },
      }).text,
  };

  it('набор скрепы совпадает с RUNTIME_AUTOFILLED_TEMPLATES — непроверенный шаблон в наборе не живёт', () => {
    deepStrictEqual(Object.keys(fill).sort(), [...RUNTIME_AUTOFILLED_TEMPLATES].sort());
  });

  // «Разведка» — меню без плейсхолдера: проверка «никакого ‹…›» ниже его не видит, поэтому
  // отдельно — после автозаполнения в поле ровно одна ветка.
  for (const explorationDone of [true, false]) {
    it(`clarification-report.template.md: «Разведка» закрыта одной веткой (разведка ${explorationDone ? 'была' : 'не была'})`, () => {
      const template = readFileSync(join(templatesDir, 'clarification-report.template.md'), 'utf8');
      const filled = autofillClarification(template, { title: 'demo', explorationDone }).text;
      const line = filled.split('\n').find((l) => l.includes('**Разведка:**')) ?? '';
      ok(line !== '', 'поле «Разведка» пропало из шаблона эталона');
      strictEqual(line.includes('exploration-report.md'), explorationDone, line);
      strictEqual(line.includes('шага не было'), !explorationDone, line);
    });
  }

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
