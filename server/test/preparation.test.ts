import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths, isRuntimeServicePath } from '../src/artifacts/paths.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { initializePreparation, preparation, preparationContext, isPreparationV2, researchProblem, requirementProblem, blockingQuestions, savePreparation, preparationFingerprint, approvePreparation, approvedPreparationProblem, preparationReviewProblem, sourceHash, recordPreparationRead, syncCanonicalPreparation, preparationSummary, requireStructuredPreparationTables, markStructuredPreparationTablesRendered } from '../src/artifacts/preparation.ts';
import { commitTargets } from '../src/run/commitByRuntime.ts';
import { claimsMinimum, isSmallContour } from '../src/run/stages/preconditions.ts';
import { readinessRun1, readinessRun2 } from '../src/run/readinessChecks.ts';
import { reviewPreparation, parseIndependentScenarios, parsePreparationReview } from '../src/run/preparationReview.ts';
import { decisionState } from '../src/run/stageInfo.ts';
import { stageById } from '../src/run/stages/index.ts';
import { seedPreparationForms } from '../src/run/preparationForms.ts';
import { countClaims } from '../src/artifacts/claims.ts';
import { preparationInstructions } from '../src/prompt/preparation.ts';
import { recordModelAnswers, askStage } from '../src/run/stages/ask.ts';
import { extractHumanFacts } from '../src/artifacts/humanFacts.ts';
import type { StageHost } from '../src/run/stages/types.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-preparation-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function paths(): WitokPaths { return new WitokPaths(root, `case-${++sequence}`); }
const draft = '# Задача\n- **Контур:** мелкий\n## Коротко\nФильтр зон для поддержки\n## Зачем\nБыстро найти тариф\n## Что делаем\nФильтруем таблицу\n## Чего не делаем\nНе меняем формат вывода\n';
const requirements = draft + `
## Приёмочный лист
| id | Пункт | Как проверить (процедура + критерий) |
|----|-------|--------------------------------------|
| claim-1 | Неизвестная зона возвращает пустой результат | Запустить list --zone missing; ожидать «ничего не найдено» и exit 0 |
## Основания и сценарии
| Основание | Сценарий | Контрпример | ID |
|-----------|----------|------------|----|
| Запрос: неизвестная зона — пустой результат | Неизвестная зона missing | Вывод полной таблицы вместо пустого результата | claim-1 |
## Инварианты
Без флага вывод не меняется — сравнить с сохранённым выводом.
`;
function fixture() {
  const p = paths();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/list.ts'), 'export function listFilter() {}\n', 'utf8');
  initializePreparation(p, 'Неизвестная зона — пустой результат, код выхода 0');
  recordPreparationRead(p, 'explore', 'src/list.ts', 'export function listFilter() {}');
  writeArtifact(p.intent, requirements);
  writeArtifact(p.plan, '# План\n## Подход\nОснован на src/list.ts\n- **Одобрение:** ‹имя и дата›\nРеализовать фильтр\n');
  writeArtifact(p.explorationReport, '## Карта кодовой базы\nИсходники: src/list.ts\n## Приёмочный лист\nСЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ');
  return p;
}
function reviewed(p: WitokPaths) {
  const state = preparation(p)!;
  savePreparation(p, { ...state, review: { fingerprint: preparationFingerprint(p), independent: 'сценарии', issues: [], completed: true } });
}
function approved(p: WitokPaths) {
  reviewed(p);
  writeArtifact(p.plan, '# План\n## Подход\nОснован на src/list.ts\n- **Одобрение:** Алексей · 2026-10-01\nРеализовать фильтр\n');
  approvePreparation(p, 'Алексей', new Date('2026-10-01T00:00:00Z'));
}

describe('версионированная проработка', () => {
  it('новый виток получает v3; явно выбранные v1/v2 остаются прежними', () => {
    const fresh = paths(); initializePreparation(fresh, '  запрос дословно  ');
    strictEqual(isPreparationV2(fresh), true);
    strictEqual(preparation(fresh)!.version, 3);
    strictEqual(preparation(fresh)!.requests[0], '  запрос дословно  ');
    const old = paths(); writeArtifact(old.intent, draft); initializePreparation(old, 'новая формулировка');
    strictEqual(isPreparationV2(old), false);
    const legacy = paths(); initializePreparation(legacy, 'запрос', 1); strictEqual(isPreparationV2(legacy), false);
    const v2 = paths(); initializePreparation(v2, 'старый структурированный виток', 2);
    strictEqual(preparation(v2)!.version, 2);
  });
  it('исследование допускает неготовую приёмку и вопросы к реализации', () => {
    const p = paths(); initializePreparation(p, 'цель');
    writeArtifact(p.intent, draft + '\n## Открытые вопросы\n- [ ] [блокирующий] Как поступить с неизвестной зоной?');
    const c = { paths: p, chunk: 1, attempt: 1 };
    strictEqual(readinessRun1(c).ready, true);
    strictEqual(claimsMinimum().check(c), null);
    strictEqual(readinessRun2(c).ready, false);
    strictEqual(isSmallContour(c), false);
  });
  it('вопрос на исследование не блокирует вход в исследование', () => {
    strictEqual(researchProblem(draft + '\n- [ ] [исследование] Какой проект исследовать?'), null);
    strictEqual(blockingQuestions('- [ ] [неблокирующий] Цвет иконки'), false);
    strictEqual(blockingQuestions('- [ ] Правило расчёта'), true);
  });
  it('один содержательный сценарий достаточен; количество edge не подменяет качество', () => {
    strictEqual(requirementProblem(requirements), null);
    deepStrictEqual(countClaims(requirements), { rows: 1, edges: 0 });
    ok(requirementProblem(requirements.replace('Вывод полной таблицы вместо пустого результата', '')));
    ok(requirementProblem(requirements.replace('## Основания и сценарии', '## Другая секция')));
  });
  it('передаёт модели только добавочный контекст этапа, а не копии всех артефактов', () => {
    const p = fixture();
    approved(p);
    writeArtifact(p.intent, requirements
      .replace('Неизвестная зона возвращает пустой результат', 'Неизвестная зона возвращает пустой результат без изменения exit-кода')
      .replace('Без флага вывод не меняется', 'Без флага вывод не меняется и кэш сохраняется'));

    const plan = preparationContext(p, 'plan');
    ok(plan?.includes('Изменён claim-1'));
    ok(plan?.includes('Изменён раздел'));
    ok(plan?.includes('кэш сохраняется'));
    ok(plan?.includes('Без флага вывод не меняется и кэш сохраняется'));
    ok(!plan?.includes('СЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ'));

    writeArtifact(p.clarificationReport, [
      '## Вопросы и ответы',
      '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
      '|---|---|---|---|---|',
      '| 1 | Допускать ли неизвестную зону? | да | Нет, вернуть пустой результат | уточняет claim-1 |',
    ].join('\n'));
    const ask = preparationContext(p, 'ask');
    ok(ask?.includes('Нет, вернуть пустой результат'));
    ok(!ask?.includes('СЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ'));
    strictEqual(preparationContext(p, 'chunk'), null);
  });
  it('до независимой проверки нельзя одобрить требования', () => {
    const p = fixture();
    throws(() => approvePreparation(p, 'Алексей', new Date()), /независимая проверка/);
    strictEqual(preparation(p)!.revisions.length, 0);
  });
  it('одобрение относится к требованиям и содержимому плана; подпись не портит fingerprint', () => {
    const p = fixture(); approved(p);
    strictEqual(approvedPreparationProblem(p), null);
    writeArtifact(p.intent, requirements.replace('exit 0', 'exit 1'));
    ok(approvedPreparationProblem(p));
    strictEqual(decisionState(stageById('plan'), { paths: p, chunk: 1, attempt: 1 }), 'pending');
    recordPreparationRead(p, 'explore', 'src/list.ts', 'export function listFilter() {}');
  writeArtifact(p.intent, requirements);
    writeArtifact(p.plan, readFileSync(p.plan, 'utf8') + '\nНовый контракт');
    ok(approvedPreparationProblem(p));
  });
  it('новое одобрение сохраняет старую редакцию дословно', () => {
    const p = fixture(); approved(p);
    const old = preparation(p)!.revisions[0]!;
    writeArtifact(p.intent, requirements.replace('Не меняем формат вывода', 'Сохраняем существующий формат вывода'));
    reviewed(p); approvePreparation(p, 'Алексей', new Date());
    const state = preparation(p)!;
    strictEqual(state.revisions.length, 2);
    strictEqual(state.revisions[0]!.intent, old.intent);
    strictEqual(approvedPreparationProblem(p), null);
  });
  it('отказ человека и позднее уточнение снимают действительность одобрения', () => {
    const p = fixture(); approved(p);
    writeArtifact(p.clarificationReport, 'Позднее уточнение: только активные зоны');
    ok(approvedPreparationProblem(p));
    writeArtifact(p.clarificationReport, '');
    writeArtifact(p.plan, '# План\n## Подход\nОснован на src/list.ts\n- **Одобрение:** **не одобрено**\nРеализовать фильтр\n');
    ok(approvedPreparationProblem(p));
  });
  it('runtime-история закрыта для записи инструментами модели', () => {
    strictEqual(isRuntimeServicePath('preparation.json'), true);
    strictEqual(isRuntimeServicePath('PREPARATION.JSON'), true);
    deepStrictEqual(commitTargets(['.sdlc/task/preparation.json', '.sdlc/task/.runner/state.json'], [], '.sdlc/task/', '/project'), ['.sdlc/task/preparation.json']);
  });
  it('повторное одобрение идемпотентно; новый исходный запрос снимает прежнее', () => {
    const p = fixture(); approved(p);
    approvePreparation(p, 'Алексей', new Date());
    strictEqual(preparation(p)!.revisions.length, 1);
    initializePreparation(p, 'Теперь неизвестная зона должна быть ошибкой');
    ok(approvedPreparationProblem(p));
    ok(preparationReviewProblem(p));
  });
  it('исходники должны быть актуальны до одобрения, после него реализация может их менять', () => {
    const p = fixture(); reviewed(p);
    const path = `source-${sequence}.ts`;
    writeArtifact(join(root, path), 'old');
    const state = preparation(p)!;
    state.review!.sourceHashes = { [path]: sourceHash('old') };
    savePreparation(p, state);
    strictEqual(preparationReviewProblem(p), null);
    writeArtifact(join(root, path), 'new');
    ok(preparationReviewProblem(p));
    writeArtifact(join(root, path), 'old');
    writeArtifact(p.plan, '# План\n## Подход\nОснован на src/list.ts\n- **Одобрение:** Алексей · 2026-10-01\nРеализовать фильтр\n');
    approvePreparation(p, 'Алексей', new Date());
    writeArtifact(join(root, path), 'implementation');
    strictEqual(preparationReviewProblem(p), null);
    strictEqual(approvedPreparationProblem(p), null);
  });
  it('показывает причину сбоя независимого ревью вместо общего сообщения', () => {
    const p = fixture();
    const state = preparation(p)!;
    savePreparation(p, { ...state, review: {
      fingerprint: preparationFingerprint(p), independent: '',
      issues: ['SyntaxError: Unexpected token } in JSON at position 17'], completed: false,
    } });
    ok(preparationReviewProblem(p)?.includes('Unexpected token'), 'ошибка протокола должна быть видна оператору');
  });
  it('v3 публикует валидированные требования и шаги из документов как структурированные данные', () => {
    const p = paths(); initializePreparation(p, 'Добавить фильтр');
    requireStructuredPreparationTables(p);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/list.ts'), 'export function list() {}\n', 'utf8');
    const canonicalIntent = [
      '# Задача: фильтр', '## Коротко', 'Фильтрация списка.', '## Зачем', 'Убрать несовпадающие элементы.',
      '## Что делаем', 'Добавить фильтр.', '## Чего не делаем', 'Не менять формат результата.',
      '## Инварианты', 'Стабильный порядок элементов.',
      '## Приёмочный лист',
      '| ID | Пункт | Как проверить (процедура + критерий) |',
      '|---|---|---|',
      '| claim-1 | Неизвестная зона даёт пустой результат | Процедура: вызвать list с неизвестной зоной. Ожидаемо: пустой список. |',
      '## Основания и сценарии',
      '| Основание | Сценарий | Контрпример | ID |',
      '|---|---|---|---|',
      '| Запрос | Неизвестная зона | Возврат всех зон | claim-1 |',
    ].join('\n');
    writeArtifact(p.intent, canonicalIntent);
    markStructuredPreparationTablesRendered(p);
    writeArtifact(p.plan, [
      '## Подход', 'Использовать src/list.ts.', '## Шаги',
      '### Шаг 1 — Добавить фильтр', '- файл: src/list.ts (существующий)', '- символ: list',
      '- действие: применить фильтр', '- закрывает: claim-1', '- проверка: вызвать функцию · ожидаемо: пустой список',
      '- контракт: n/a — контракт прежний', '- зависит от: нет', '- факты человека: n/a',
      '## files_to_touch', '| Путь | Что делаем |', '|---|---|', '| src/list.ts | фильтр |',
    ].join('\n'));
    syncCanonicalPreparation(p);
    const result = preparationSummary(p)!;
    strictEqual(result.version, 3);
    strictEqual(result.canonical?.requirements?.acceptance[0]?.id, 'claim-1');
    strictEqual(result.canonical?.requirements?.acceptance[0]?.expected, 'пустой список.');
    strictEqual(result.canonical?.requirements?.constraints.invariants[0], 'Стабильный порядок элементов.');
    strictEqual(result.canonical?.plan?.filesToTouch.includes('src/list.ts'), true);
    ok(result.canonical?.plan?.fileRoles.some((item) => item.path === 'src/list.ts' && item.roles.includes('target')));
    strictEqual(result.canonical?.plan?.steps[0]?.claims[0], 'claim-1');
    strictEqual(requirementProblem(canonicalIntent, result.canonical?.requirements), null);
    writeArtifact(p.intent, canonicalIntent.replace('пустой список.', 'все зоны'));
    ok(requirementProblem(readFileSync(p.intent, 'utf8'), result.canonical?.requirements)?.includes('устарели'));
  });
  it('разведка не требует второго отдельного подтверждения полноты', () => {
    const p = fixture();
    strictEqual(decisionState(stageById('explore'), { paths: p, chunk: 1, attempt: 1 }), null);
  });
  it('отложенный вопрос не запускает ask; изменённый ответ сохраняется отдельным фактом', () => {
    const p = fixture();
    writeArtifact(p.intent, requirements + '\n## Открытые вопросы\n- [ ] [неблокирующий] Цвет будущей иконки');
    ok(askStage.skipIf!({ paths: p, chunk: 1, attempt: 1 }));
    writeArtifact(p.clarificationReport, '## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |\n|---|---|---|---|---|\n');
    const host = { paths: p, signal: () => new AbortController().signal, writeAutofilled: (path: string, text: string) => writeArtifact(path, text) } as unknown as StageHost;
    const question = { id: 'zone', question: 'Какой код выхода?', header: 'Блокирующий', multiSelect: false, options: [] };
    recordModelAnswers(host, [question], { zone: ['0'] });
    recordModelAnswers(host, [question], { zone: ['1'] });
    recordModelAnswers(host, [question], { zone: ['1'] });
    deepStrictEqual(extractHumanFacts(readFileSync(p.clarificationReport, 'utf8')).map((f) => f.answer), ['0', '1']);
  });
  it('новые формы не воспроизводят запрет ИИ составлять приёмку и численные квоты', () => {
    const p = paths(); initializePreparation(p, 'цель');
    writeArtifact(p.intent, '<!-- sdlc-template: intent v1 -->\nстарый шаблон');
    const seeded = [{ path: p.intent, template: 'fixture' }]; seedPreparationForms(p, seeded);
    const text = readFileSync(p.intent, 'utf8');
    ok(text.includes('ИИ готовит'));
    ok(text.includes('sdlc-json:acceptance:start'));
    ok(text.includes('sdlc-json:basis:start'));
    ok(preparationInstructions('', 'plan').includes('Контрпример') || preparationInstructions('', 'plan').includes('контрпример'));
  });
});

describe('независимая критика плана', () => {
  it('нормализует структурированные замечания для арбитража, сохраняя основание и место плана', () => {
    deepStrictEqual(parsePreparationReview(JSON.stringify({ issues: [{ defect: 'Пропущен сценарий', basis: 'источник X', location: 'Шаг 1', counterexample: 'вход Y' }] })), [
      'Пропущен сценарий — Основание: источник X — Место плана: Шаг 1 — Контрпример: вход Y',
    ]);
  });

  it('принимает единственную лишнюю закрывающую скобку в JSON-ответе локальной модели', () => {
    deepStrictEqual(parsePreparationReview('{"issues":[]}}'), []);
    deepStrictEqual(parseIndependentScenarios('{"scenarios":[]}}'), []);
    throws(() => parsePreparationReview('{"issues":[]} текст'));
  });

  function reviewer(p: WitokPaths, answers: string[], captured: ExecRequest[], preparationModes: boolean[] = []) {
    return {
      paths: p, id: 'test', projectRoot: root, emit: () => {}, signal: () => new AbortController().signal,
      verifyRoute: () => ({ flow: 'loop', model: 'strong', providerDef: { currency: 'USD' } }),
      maxBudgetUsd: 10, spentBefore: () => 0, accountOffPathUsage: () => {},
      executorFor: (_stage: string, _route: unknown, preparationForms: boolean) => {
        preparationModes.push(preparationForms);
        return { run: async (req: ExecRequest) => { captured.push(req); return { ok: true, finalText: answers.shift() ?? '', usage: emptyUsage() }; } };
      },
    } as unknown as StageHost;
  }
  it('первый запрос не видит авторских claims, план и интерпретацию ответов', async () => {
    const p = fixture(); const captured: ExecRequest[] = []; const preparationModes: boolean[] = [];
    writeFileSync(join(root, 'src/index.ts'), "export { listFilter } from './list.ts';\n", 'utf8');
    const state = preparation(p)!;
    savePreparation(p, { ...state, requests: ['Не меняй src/list.ts; экспортируй его из src/index.ts.'] });
    writeArtifact(p.clarificationReport, '## Уточнённое требование и подход\nСЕКРЕТ_ИНТЕРПРЕТАЦИИ');
    strictEqual(await reviewPreparation(reviewer(p, ['{"scenarios":[{"scenario":"Перенос","incorrectBehavior":"Меняется id","basis":"Запрос требует сохранить id"}]}', '{"issues":[]}'], captured, preparationModes), {} as ExecHooks), null);
    strictEqual(captured.length, 2);
    ok(!captured[0]!.prompt.user.includes('Реализовать фильтр'));
    ok(!captured[0]!.prompt.user.includes('СЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ'));
    ok(!captured[0]!.prompt.user.includes('СЕКРЕТ_ИНТЕРПРЕТАЦИИ'));
    ok(captured[0]!.prompt.user.includes("### src/index.ts\nexport { listFilter } from './list.ts';"), 'first review pass receives original-request sources even if the author map omitted them');
    ok(captured[1]!.prompt.user.includes('"scenario":"Перенос"'));
    deepStrictEqual(captured[0]!.allowedTools, []);
    deepStrictEqual(captured[0]!.subagents, []);
    deepStrictEqual(preparationModes, [false, false], 'independent review must use the ordinary loop executor');
  });
  it('замечание о тесте, подтверждающем неверное понимание, блокирует одобрение', async () => {
    const p = fixture(); const captured: ExecRequest[] = [];
    const finding = 'Тест ждёт exit 1, запрос требует 0: unknown-zone выявит расхождение';
    const problem = await reviewPreparation(reviewer(p, ['{"scenarios":[]}', JSON.stringify({ issues: [finding] }), JSON.stringify({ issues: [finding] })], captured), {} as ExecHooks);
    ok(problem?.includes('exit 1'));
    strictEqual(captured.length, 3, 'непустые замечания должны пройти арбитраж');
    throws(() => approvePreparation(p, 'Алексей', new Date()), /требует исправлений/);
  });
  it('ошибка формата и изменение источника после проверки не дают зелёный результат', async () => {
    const p = fixture();
    ok(await reviewPreparation(reviewer(p, ['невалидный разбор', 'всё отлично'], []), {} as ExecHooks));
    strictEqual(preparation(p)!.review!.completed, false);
    reviewed(p);
    writeArtifact(p.explorationReport, 'Новые факты о контракте');
    ok(preparationReviewProblem(p));
    throws(() => parsePreparationReview('{"issues":[false]}'));
    throws(() => parseIndependentScenarios('{"scenarios":[{"scenario":"x"}]}'));
  });
});
