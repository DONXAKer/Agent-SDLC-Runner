import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuidedScenarios } from '../src/simulator/guided.ts';
import { reportPassed } from '../src/simulator/report.ts';

test('guided: конечные сценарии ремонта, отказа и восстановления', async () => {
  const results = await runGuidedScenarios();
  assert.equal(results.length, 4);
  for (const result of results) assert.equal(result.passed, true, `${result.id}: ${result.errors.join('; ')}`);
});

test('отчёт не превращает отсутствие проверки или ошибку оракула в PASS', () => {
  assert.equal(reportPassed([]), false);
  assert.equal(reportPassed([{ passed: true, checks: [], errors: [] }]), false);
  assert.equal(reportPassed([{ passed: true, checks: ['сверка'], errors: ['нарушение'] }]), false);
  assert.equal(reportPassed([{ passed: false, checks: ['сверка'], errors: [] }]), false);
  assert.equal(reportPassed([{ passed: true, checks: ['ожидаемая блокировка'], errors: [] }]), true);
});
