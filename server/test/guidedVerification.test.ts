import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGuidedVerification } from '../src/run/guidedVerification.ts';
import { readReport } from '../src/verdict/collect.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';
import { countPlaceholdersExceptDecisions } from '../src/artifacts/artifact.ts';
import type { FindingRecord } from '../src/run/verifyReport.ts';

const input = {
  header: '# Отчёт приёмки: test',
  gates: [{ name: 'Тесты', status: '✅' as const, command: 'node --test', exitCode: 0,
    lastLine: 'passed 8', durationMs: 10, envBlocked: false }],
  requiredGates: [{ name: 'Тесты', runtime: false }],
  claims: [{ id: 'claim-1', status: '✅' as const, evidence: 'src/check.ts:validate', whatToFix: null }],
  titles: new Map([['claim-1', 'Validate input']]),
  findings: [] as FindingRecord[], reviewComplete: true, earlyGates: [],
};
test('checked observations produce a complete report without synthetic human signatures', () => {
  const text = renderGuidedVerification(input);
  assert.equal(countPlaceholdersExceptDecisions(text), 0);
  const facts = readReport(text);
  assert.equal(facts.confirmedReviewFindings, 0);
  assert.deepEqual(facts.plannedPathsUntouched, []);
  assert.deepEqual(facts.regressions, []);
  assert.deepEqual(facts.claims, [{ id: 'claim-1', status: '✅' }]);
  assert.equal(facts.inapplicable.size, 0);
});
test('red gates and claims are preserved', () => {
  const text = renderGuidedVerification({ ...input,
    gates: [{ ...input.gates[0]!, status: '❌', exitCode: 1 }],
    claims: [{ ...input.claims[0]!, status: '⚠' }] });
  const facts = readReport(text);
  assert.equal(facts.gateStatuses.get('тесты'), '❌');
  assert.equal(facts.claims[0]?.status, '⚠');
});
for (const section of ['review', 'scope', 'invariant', 'regression'] as const) {
  test(`anchored ${section} finding remains visible and blocking`, () => {
    const facts = readReport(renderGuidedVerification({ ...input,
      findings: [{ section, text: 'unexpected behavior', evidence: 'src/check.ts:12', anchored: true }] }));
    assert.ok(facts.confirmedReviewFindings + facts.brokenInvariants.length + facts.regressions.length > 0);
  });
}
test('missing claims, unfinished scans and unexecuted model gates stay incomplete', () => {
  const text = renderGuidedVerification({ ...input, claims: [], reviewComplete: false,
    requiredGates: [...input.requiredGates, { name: 'Ручная проверка', runtime: false }] });
  assert.ok(countPlaceholdersExceptDecisions(text) > 0);
  assert.equal(readReport(text).claims[0]?.status, '⚠');
});
test('unanchored concerns do not become a clean report', () => {
  const text = renderGuidedVerification({ ...input,
    findings: [{ section: 'review', text: 'possible defect', evidence: 'unknown', anchored: false }] });
  assert.ok(countPlaceholdersExceptDecisions(text) > 0);
  assert.ok(text.includes('possible defect'));
});

/** Вердикт из фактов отчёта — минимальный вход, как у зелёного прогона. */
function verdictOf(text: string) {
  const facts = readReport(text);
  return computeVerdict({
    gates: [{ name: 'Тесты', status: '✅', inapplicableSignedBy: null }],
    claims: facts.claims,
    confirmedReviewFindings: facts.confirmedReviewFindings,
    enabledGatesMissingFromReport: [],
    openDebtRows: [],
    brokenInvariants: facts.brokenInvariants,
    regressions: facts.regressions,
    plannedPathsUntouched: facts.plannedPathsUntouched,
    diffMatchesTree: true,
    attempt: 1,
    attemptBudget: 3,
    noProgress: false,
  });
}

// Норма verify редизайна «модель решает — рантайм пишет» (guided.md, 2026-10-05/06):
// саморевью не уровень вердикта; блокируют только находки отдельного review-маршрута.
test('self-review findings are advisory: visible in the report, verdict stays green', () => {
  const text = renderGuidedVerification({ ...input, scanIndependent: false,
    findings: [
      { section: 'review', text: 'Подтверждённое расхождение: price is not rounded', evidence: 'src/check.ts:12', anchored: true, advisory: true },
      { section: 'regression', text: 'far zone uses a foreign tariff', evidence: 'src/zones.ts:3', anchored: true, advisory: true },
    ] });
  // (в) advisory-находки попадают в отчёт и не оставляют его незаполненным.
  assert.equal(countPlaceholdersExceptDecisions(text), 0);
  assert.ok(text.includes('price is not rounded'));
  assert.ok(text.includes('advisory'));
  // (а) находки саморевью не роняют вердикт — разбор их не видит вовсе.
  const facts = readReport(text);
  assert.equal(facts.confirmedReviewFindings, 0);
  assert.deepEqual(facts.regressions, []);
  assert.ok(verdictOf(text).passed, verdictOf(text).reasons.join('; '));
});

test('advisory finding without an anchor still leaves a complete report', () => {
  const text = renderGuidedVerification({ ...input, scanIndependent: false,
    findings: [{ section: 'review', text: 'possible defect', evidence: 'unknown', anchored: false, advisory: true }] });
  assert.equal(countPlaceholdersExceptDecisions(text), 0);
  assert.ok(text.includes('possible defect'));
  assert.ok(verdictOf(text).passed);
});

test('findings of a separate review route remain blocking', () => {
  // (б) та же находка БЕЗ пометки advisory (маршрут рецензента ≠ исполнитель) —
  // по-прежнему роняет вердикт.
  const text = renderGuidedVerification({ ...input,
    findings: [{ section: 'review', text: 'price is not rounded', evidence: 'src/check.ts:12', anchored: true }] });
  assert.equal(readReport(text).confirmedReviewFindings, 1);
  assert.ok(!verdictOf(text).passed);
});
