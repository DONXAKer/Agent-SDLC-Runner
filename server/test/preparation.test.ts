import { strictEqual, ok, throws, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { emptyUsage } from '@sdlc-runner/shared';
import { WitokPaths, isRuntimeServicePath } from '../src/artifacts/paths.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { initializePreparation, preparation, isPreparationV2, researchProblem, requirementProblem, blockingQuestions, savePreparation, preparationFingerprint, approvePreparation, approvedPreparationProblem, preparationReviewProblem, sourceHash } from '../src/artifacts/preparation.ts';
import { commitTargets } from '../src/run/commitByRuntime.ts';
import { claimsMinimum, isSmallContour } from '../src/run/stages/preconditions.ts';
import { readinessRun1, readinessRun2 } from '../src/run/readinessChecks.ts';
import { reviewPreparation, parsePreparationReview } from '../src/run/preparationReview.ts';
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
  initializePreparation(p, 'Неизвестная зона — пустой результат, код выхода 0');
  writeArtifact(p.intent, requirements);
  writeArtifact(p.plan, '# План\n- **Одобрение:** ‹имя и дата›\nРеализовать фильтр\n');
  writeArtifact(p.explorationReport, '## Карта кодовой базы\nИсходники: src/list.ts\n## Приёмочный лист\nСЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ');
  return p;
}
function reviewed(p: WitokPaths) {
  const state = preparation(p)!;
  savePreparation(p, { ...state, review: { fingerprint: preparationFingerprint(p), independent: 'сценарии', issues: [], completed: true } });
}
function approved(p: WitokPaths) {
  reviewed(p);
  writeArtifact(p.plan, '# План\n- **Одобрение:** Алексей · 2026-10-01\nРеализовать фильтр\n');
  approvePreparation(p, 'Алексей', new Date('2026-10-01T00:00:00Z'));
}

describe('проработка v2', () => {
  it('новый виток получает v2; старый и явно выбранный v1 не мигрируют', () => {
    const fresh = paths(); initializePreparation(fresh, '  запрос дословно  ');
    strictEqual(isPreparationV2(fresh), true);
    strictEqual(preparation(fresh)!.requests[0], '  запрос дословно  ');
    const old = paths(); writeArtifact(old.intent, draft); initializePreparation(old, 'новая формулировка');
    strictEqual(isPreparationV2(old), false);
    const legacy = paths(); initializePreparation(legacy, 'запрос', 1); strictEqual(isPreparationV2(legacy), false);
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
  it('вопрос, блокирующий само исследование, останавливает вход', () => {
    ok(researchProblem(draft + '\n- [ ] [исследование] Какой проект исследовать?'));
    strictEqual(blockingQuestions('- [ ] [неблокирующий] Цвет иконки'), false);
    strictEqual(blockingQuestions('- [ ] Правило расчёта'), true);
  });
  it('один содержательный сценарий достаточен; количество edge не подменяет качество', () => {
    strictEqual(requirementProblem(requirements), null);
    deepStrictEqual(countClaims(requirements), { rows: 1, edges: 0 });
    ok(requirementProblem(requirements.replace('Вывод полной таблицы вместо пустого результата', '')));
    ok(requirementProblem(requirements.replace('## Основания и сценарии', '## Другая секция')));
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
    writeArtifact(p.plan, '# План\n- **Одобрение:** **не одобрено**\nРеализовать фильтр\n');
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
    writeArtifact(p.plan, '# План\n- **Одобрение:** Алексей · 2026-10-01\nРеализовать фильтр\n');
    approvePreparation(p, 'Алексей', new Date());
    writeArtifact(join(root, path), 'implementation');
    strictEqual(preparationReviewProblem(p), null);
    strictEqual(approvedPreparationProblem(p), null);
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
    ok(text.includes('Основание | Сценарий | Контрпример | ID'));
    ok(preparationInstructions('', 'plan').includes('Контрпример') || preparationInstructions('', 'plan').includes('контрпример'));
  });
});

describe('независимая критика плана', () => {
  function reviewer(p: WitokPaths, answers: string[], captured: ExecRequest[]) {
    return {
      paths: p, id: 'test', projectRoot: root, emit: () => {}, signal: () => new AbortController().signal,
      verifyRoute: () => ({ flow: 'loop', model: 'strong', providerDef: { currency: 'USD' } }),
      maxBudgetUsd: 10, spentBefore: () => 0, accountOffPathUsage: () => {},
      executorFor: () => ({ run: async (req: ExecRequest) => { captured.push(req); return { ok: true, finalText: answers.shift() ?? '', usage: emptyUsage() }; } }),
    } as unknown as StageHost;
  }
  it('первый запрос не видит авторских claims, план и интерпретацию ответов', async () => {
    const p = fixture(); const captured: ExecRequest[] = [];
    writeArtifact(p.clarificationReport, '## Уточнённое требование и подход\nСЕКРЕТ_ИНТЕРПРЕТАЦИИ');
    strictEqual(await reviewPreparation(reviewer(p, ['НЕЗАВИСИМЫЙ_РАЗБОР', '{"issues":[]}'], captured), {} as ExecHooks), null);
    strictEqual(captured.length, 2);
    ok(!captured[0]!.prompt.user.includes('Реализовать фильтр'));
    ok(!captured[0]!.prompt.user.includes('СЕКРЕТ_АВТОРСКОЙ_ПРИЁМКИ'));
    ok(!captured[0]!.prompt.user.includes('СЕКРЕТ_ИНТЕРПРЕТАЦИИ'));
    ok(captured[1]!.prompt.user.includes('НЕЗАВИСИМЫЙ_РАЗБОР'));
    deepStrictEqual(captured[0]!.allowedTools, []);
    deepStrictEqual(captured[0]!.subagents, []);
  });
  it('замечание о тесте, подтверждающем неверное понимание, блокирует одобрение', async () => {
    const p = fixture(); const captured: ExecRequest[] = [];
    const problem = await reviewPreparation(reviewer(p, ['анализ', '{"issues":["Тест ждёт exit 1, запрос требует 0: unknown-zone выявит расхождение"]}'], captured), {} as ExecHooks);
    ok(problem?.includes('exit 1'));
    throws(() => approvePreparation(p, 'Алексей', new Date()), /требует исправлений/);
  });
  it('ошибка формата и изменение источника после проверки не дают зелёный результат', async () => {
    const p = fixture();
    ok(await reviewPreparation(reviewer(p, ['анализ', 'всё отлично'], []), {} as ExecHooks));
    strictEqual(preparation(p)!.review!.completed, false);
    reviewed(p);
    writeArtifact(p.explorationReport, 'Новые факты о контракте');
    ok(preparationReviewProblem(p));
    throws(() => parsePreparationReview('{"issues":[false]}'));
  });
});
