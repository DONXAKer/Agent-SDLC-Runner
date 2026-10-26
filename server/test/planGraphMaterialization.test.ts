import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AXES } from '../src/artifacts/planAxes.ts';
import type { Plan } from '../src/artifacts/guidedIr.ts';
import { materializeGuidedPlanImplementation } from '../src/run/stages/plan.ts';

const emptyPlan = (): Plan => ({
  approach: 'Implement and verify the requested behavior', steps: [], excluded: [],
  axes: AXES.map(name => ({ name, affected: false, reason: 'No impact yet', outcome: 'н/п — будет уточнено' })),
  changes: 'No requirement changes', callers: [],
});

const withProject = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'typed-plan-targets-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'feature.ts'), 'export const existing = 1;\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export { existing } from "./feature";\n');
    writeFileSync(join(root, 'test', 'existing.test.ts'), '');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const intent = [
  '## Что делаем',
  'Реализация функции convertItem в src/feature.ts и её экспорт из src/index.ts; добавить тесты в новом файле в test/.',
  '',
  '## Чего не делаем',
  'Не изменять существующие тесты.',
  '',
  '## Приёмочный лист',
  '| ID | Пункт | Как проверить |',
  '|---|---|---|',
  '| claim-1 | convertItem доступна из src/index.ts | Процедура: импортировать convertItem из src/index.ts Ожидаемо: экспорт доступен |',
].join('\n');

test('mandatory implementation, export and new test targets are materialized in the graph', () => withProject(root => {
  const result = materializeGuidedPlanImplementation(emptyPlan(), intent, root);
  assert.equal(result.changed, true);
  assert.deepEqual(result.paths, ['src/feature.ts', 'src/index.ts', 'test/convertItem.test.ts']);
  const source = result.plan.steps.find(step => step.file === 'src/feature.ts');
  const exported = result.plan.steps.find(step => step.file === 'src/index.ts');
  const tests = result.plan.steps.find(step => step.file === 'test/convertItem.test.ts');
  assert.ok(source && exported && tests);
  assert.equal(exported.symbol, 'новый: convertItem');
  assert.deepEqual(exported.dependsOn, [source.id]);
  assert.deepEqual(exported.claims, ['claim-1']);
  assert.ok(tests.claims.includes('claim-1'));
  assert.equal(tests.isNew, true);
  for (const step of result.plan.steps) {
    for (const field of [step.symbol, step.action, step.check, step.expected, step.contract]) assert.ok(field.length > 0);
  }
}));

test('typed materialization is idempotent and does not rewrite authored fields', () => withProject(root => {
  const first = materializeGuidedPlanImplementation(emptyPlan(), intent, root).plan;
  first.steps[0]!.action = 'Authored implementation action';
  const snapshot = structuredClone(first);
  const second = materializeGuidedPlanImplementation(first, intent, root);
  assert.equal(second.changed, false);
  assert.deepEqual(second.paths, []);
  assert.deepEqual(second.plan, snapshot);
}));

test('an authored valid new test path does not produce a second fallback test', () => withProject(root => {
  const authored = emptyPlan();
  authored.steps.push({
    id: 1, file: 'test/custom.test.ts', isNew: true, symbol: 'тест', action: 'Add behavioral tests',
    claims: ['claim-1'], check: 'Run the new test file', expected: 'The acceptance scenario passes',
    contract: 'н/п — tests do not change the public API', dependsOn: [],
  });
  const result = materializeGuidedPlanImplementation(authored, intent, root);
  assert.equal(result.testPath, 'test/custom.test.ts');
  assert.equal(result.plan.steps.some(step => step.file === 'test/convertItem.test.ts'), false);
  assert.equal(result.plan.steps.filter(step => /^tests?\//u.test(step.file)).length, 1);
}));
