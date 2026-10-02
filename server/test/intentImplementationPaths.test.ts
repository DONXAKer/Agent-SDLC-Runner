import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { enforceIntentTestFileTarget, extractExplicitExportPaths, extractIntentImplementationPaths, intentImplementationPathsProblem, intentNewTestPath, intentPlanBoundaryProblem, preparePlanImplementationCards } from '../src/run/stages/plan.ts';

it('preserves explicit export targets from the original request after Intent drops them', () => {
  const requests = ['Добавь moveHold(...) в src/hold.ts и экспортируй её из src/index.ts'];
  deepStrictEqual(extractExplicitExportPaths(requests), ['src/index.ts']);
  deepStrictEqual(extractExplicitExportPaths(['Посмотри src/index.ts и src/hold.ts']), []);
  const intent = '## Что делаем\nДобавить moveHold в src/hold.ts.\n';
  const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| src/hold.ts | добавить функцию |\n';
  ok(intentImplementationPathsProblem(intent, plan, extractExplicitExportPaths(requests))?.includes('src/index.ts'));
});

it('requires every explicit implementation path from Intent in the plan allowlist', () => {
  const intent = '## Что делаем\nДобавить moveHold в `src/hold.ts` и экспортировать из `src/index.ts`. Создать новый тест в test/.\n';
  const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| `src/hold.ts` | добавить функцию |\n';
  const problem = intentImplementationPathsProblem(intent, plan);
  ok(problem?.includes('src/index.ts'));
  strictEqual(problem?.includes('src/hold.ts'), false);
});

it('passes when all explicit implementation paths are planned', () => {
  const intent = '## Что делаем\nДобавить moveHold в `src/hold.ts` и экспортировать из `src/index.ts`.\n';
  const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| `src/hold.ts` | добавить функцию |\n| `src/index.ts` | добавить экспорт |\n';
  strictEqual(intentImplementationPathsProblem(intent, plan), null);
});

it('rejects a plan that touches a forbidden file or points a target card at another Intent file', () => {
  const intent = [
    '## Что делаем',
    'Реализация функции moveHold в src/hold.ts и экспорт из src/index.ts.',
    '',
    '## Чего не делаем',
    'Не изменять src/slots.ts и существующие тесты.',
  ].join('\n');
  const forbiddenPlan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| src/slots.ts | изменить |';
  ok(intentPlanBoundaryProblem(intent, forbiddenPlan)?.includes('src/slots.ts'));
  const wrongCard = [
    '### Шаг 1 — Реализовать функцию',
    '- файл: src/index.ts (существующий)',
    '- символ: moveHold',
    '- действие: добавить функцию в src/hold.ts',
  ].join('\n');
  ok(intentPlanBoundaryProblem(intent, wrongCard)?.includes('действие описывает src/hold.ts'));
  strictEqual(intentPlanBoundaryProblem(intent, [
    '### Шаг 1 — Экспортировать функцию',
    '- файл: src/index.ts (существующий)',
    '- символ: moveHold',
    '- действие: экспортировать src/hold.ts из src/index.ts',
  ].join('\n')), null);
});

it('rejects edits to existing tests when Intent permits only a new test file', () => {
  const intent = '## Чего не делаем\nне делаем: изменение существующих тестов; нужен тест в новом файле.\n';
  const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| test/hold.test.ts | добавить проверку |\n';
  const root = join(process.cwd(), '..', 'bench', 'fixtures', 'booking');
  ok(intentPlanBoundaryProblem(intent, plan, root)?.includes('test/hold.test.ts'));
  strictEqual(intentPlanBoundaryProblem(intent,
    '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| test/moveHold.test.ts | создать новый тест |\n', root), null);
});

it('recognizes implementation nouns used by compact Intent wording', () => {
  const intent = '## Что делаем\nРеализация функции moveHold в src/hold.ts и её экспорт из src/index.ts.\n';
  const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| src/hold.ts | реализация функции |\n';
  ok(intentImplementationPathsProblem(intent, plan)?.includes('src/index.ts'));
});

it('keeps implementation targets and skips files named only as analysis evidence', () => {
  const intent = '## Что делаем\nРеализация moveHold в src/hold.ts, экспорт из src/index.ts; выбор способа после анализа src/hold.ts и test/hold.test.ts.\n';
  const paths = extractIntentImplementationPaths(intent);
  ok(paths.includes('src/hold.ts'));
  ok(paths.includes('src/index.ts'));
  strictEqual(paths.includes('test/hold.test.ts'), false);
});

it('seeds Intent implementation paths and adds their editable cards before plan drafting', () => {
  const intent = [
    '## Что делаем',
    'Реализация функции moveHold(hold, newSlot) в src/hold.ts и её экспорт из src/index.ts; добавить тесты в новом файле в test/.',
    '',
    '## Приёмочный лист',
    '| ID | Пункт | Как проверить |',
    '|---|---|---|',
    '| claim-1 | moveHold доступна из src/index.ts | Процедура: импортировать moveHold из src/index.ts Ожидаемо: экспорт доступен |',
    '',
  ].join('\n');
  const plan = [
    '## Шаги',
    '### Шаг 1 — Реализовать функцию',
    '- файл: ‹существующий путь› (существующий)',
    '- символ: ‹символ›',
    '- действие: ‹изменение›',
    '- закрывает: ‹claim-N›',
    '- проверка: ‹проверка› · ожидаемо: ‹результат›',
    '- контракт: ‹контракт›',
    '- зависит от: нет',
    '- факты человека: н/п',
    '',
    '### Шаг 2 — Проверить перенос',
    '- файл: ‹новый путь теста› (новый)',
    '- символ: тест',
    '- действие: добавить тесты',
    '- закрывает: ‹claim-N›',
    '- проверка: ‹проверка› · ожидаемо: ‹результат›',
    '- контракт: н/п — тест',
    '- зависит от: 1',
    '- факты человека: н/п',
    '',
    '## files_to_touch',
    '| Путь | Что делаем |',
    '|---|---|',
  ].join('\n');
  const root = join(process.cwd(), '..', 'bench', 'fixtures', 'booking');
  const result = preparePlanImplementationCards(plan, intent, root);
  ok(result.text.includes('| `src/hold.ts` |'));
  ok(result.text.includes('| `src/index.ts` |'));
  ok(result.text.includes('| `test/moveHold.test.ts` |'));
  ok(result.text.includes('- файл: src/hold.ts (существующий)'));
  ok(result.text.includes('- файл: test/moveHold.test.ts (новый)'));
  ok(result.text.includes('### Шаг 3 — Изменить src/index.ts'));
  ok(result.text.includes('- символ: новый: moveHold'));
  ok(result.text.includes('- действие: Экспортировать moveHold'));
  ok(result.text.includes('- закрывает: claim-1'));
  ok(result.text.includes('- зависит от: шаг 1'));
  ok(result.text.includes('- действие: Добавить поведенческие тесты: claim-1:'));
  strictEqual(result.text.includes('исходный Hold не мутируется'), false, 'общий планировщик не добавляет контракт конкретной задачи');
  deepStrictEqual(result.paths, ['src/hold.ts', 'src/index.ts', 'test/moveHold.test.ts']);
});

it('restores the generated new test path when the model selects an existing forbidden test', () => {
  const intent = [
    '## Что делаем',
    'Реализация функции moveHold(hold, newSlot) в src/hold.ts; создать новый файл тестов в test/.',
    '',
    '## Чего не делаем',
    'Не меняем существующие файлы в папке test/.',
  ].join('\n');
  const plan = [
    '### Шаг 7 — Добавить тесты',
    '- файл: test/hold.test.ts (новый)',
    '- действие: добавить тесты',
    '',
    '## files_to_touch',
    '| Путь | Что делаем |',
    '|---|---|',
    '| test/hold.test.ts | добавить тесты |',
  ].join('\n');
  const root = join(process.cwd(), '..', 'bench', 'fixtures', 'booking');
  const result = enforceIntentTestFileTarget(plan, intent, root);
  strictEqual(result.path, 'test/moveHold.test.ts');
  strictEqual(result.changed, true);
  ok(result.text.includes('- файл: test/moveHold.test.ts (новый)'));
  ok(result.text.includes('| `test/moveHold.test.ts` |'));
  strictEqual(result.text.includes('| test/hold.test.ts |'), false);
});

it('infers a new test path when Intent forbids existing test edits but drops the explicit new-file phrase', () => {
  const intent = [
    '## Что делаем',
    'Пользователь может перенести бронь на другой слот; результат сохраняет id и expiresIso.',
    '',
    '## Чего не делаем',
    'Не изменять существующие тесты `test/hold.test.ts`.',
    '',
    '## Приёмочный лист',
    '| ID | Пункт | Процедура |',
    '|---|---|---|',
    '| claim-1 | Перенос брони | Создание функции moveHold, которая обновляет слот |',
  ].join('\n');
  const root = join(process.cwd(), '..', 'bench', 'fixtures', 'booking');
  strictEqual(intentNewTestPath(intent, root), 'test/moveHold.test.ts');
});

it('uses the original task to restore a required new test when Intent omits that detail', () => {
  const intent = '## Что делаем\nРеализовать функцию moveHold в src/hold.ts.\n';
  const request = 'Добавить поведенческие тесты в новом файле в test/. Существующие тесты не менять.';
  const root = join(process.cwd(), '..', 'bench', 'fixtures', 'booking');
  strictEqual(intentNewTestPath(intent, root, [request]), 'test/moveHold.test.ts');
});

it('infers a new test target from the repository convention and leaves unknown conventions to the plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-test-convention-'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'test_existing.py'), '', 'utf8');
  const intent = '## Что делаем\nРеализовать функцию parseRecord.\n## Чего не делаем\nНе изменять существующие тесты.\n';
  const request = 'Добавить тесты в новом файле. Существующие тесты не менять.';
  strictEqual(intentNewTestPath(intent, root, [request]), 'tests/test_parse_record.py');
  rmSync(root, { recursive: true, force: true });
  const unknown = mkdtempSync(join(tmpdir(), 'sdlc-test-unknown-'));
  mkdirSync(join(unknown, 'checks'), { recursive: true });
  writeFileSync(join(unknown, 'checks', 'suite.custom'), '', 'utf8');
  strictEqual(intentNewTestPath(intent, unknown, [request]), null);
  rmSync(unknown, { recursive: true, force: true });
});
