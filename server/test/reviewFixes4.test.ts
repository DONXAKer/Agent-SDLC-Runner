/**
 * Регрессии ревью code-review-all 2026-09-23 по волнам 1–3 (вердикт на диске — отдельно,
 * `verdictOnDisk.test.ts`). Каждый кейс воспроизводит находку, подтверждённую до правки.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult, NormalizedCall, PolicyContext, VerdictInput } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { evaluate } from '../src/policy/index.ts';
import { readinessVerdict } from '../src/run/stages/preconditions.ts';
import { MODEL_REPORTED_GATES, RECONCILE_GATE, isReportedGate } from '../src/run/stages/verify/gates.ts';
import { autofillVerificationReport } from '../src/run/verifyAutofill.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';

describe('класс среды для blocked_env — слово в любом месте имени, не подстрока', () => {
  const input = (name: string): VerdictInput => ({
    gates: [{ name, status: '⏭', inapplicableSignedBy: null, envBlocked: true }],
    claims: [],
    confirmedReviewFindings: 0,
    enabledGatesMissingFromReport: [],
    openDebtRows: [],
    brokenInvariants: [],
    regressions: [],
    plannedPathsUntouched: [],
    diffMatchesTree: true,
    attempt: 1,
    attemptBudget: 3,
    noProgress: false,
  });

  for (const name of ['Юнит-тесты', 'Интеграционные тесты', 'Сборка/тесты', 'Установка зависимостей']) {
    it(`«${name}» — среда`, () => strictEqual(computeVerdict(input(name), []).action, 'blocked_env'));
  }
  for (const name of ['Аудит зависимостей', 'Сверка тестов с claims']) {
    it(`«${name}» — не среда: обычный retry`, () => strictEqual(computeVerdict(input(name), []).action, 'retry'));
  }
});

describe('вердикт готовности не только в начале строки', () => {
  it('«❌ не готова» и «Задача не готова» — отказ; «✅ готова» — готова', () => {
    strictEqual(readinessVerdict('**Вердикт прогона 1:** ❌ не готова — лист неполон', 1), 'not');
    strictEqual(readinessVerdict('**Вердикт прогона 2:** Задача не готова', 2), 'not');
    strictEqual(readinessVerdict('**Вердикт прогона 1:** ✅ готова', 1), 'ready');
    strictEqual(readinessVerdict('**Вердикт прогона 1:** неготова', 1), null);
  });
});

describe('гейты, статус которых берётся из отчёта', () => {
  it('рантайм их не «прогоняет», а автозаполнение даёт строку модели и строку сверки', () => {
    for (const n of [RECONCILE_GATE, ...MODEL_REPORTED_GATES]) ok(isReportedGate(n), n);
    ok(!isReportedGate('Тесты'));
    const report = '## Гейты\n\n| Гейт | Статус | Результат |\n|---|---|---|\n| ‹имя из набора› | ‹✅/❌/⏭› | ‹результат› |\n';
    const ran: GateRunResult = { name: 'Тесты', status: '✅', command: 'npm test', exitCode: 0, durationMs: 0, lastLine: 'ok', envBlocked: false };
    const { text } = autofillVerificationReport(report, [ran], {
      chunk: 1,
      attempt: 1,
      slug: 'demo',
      attemptBudget: 3,
      gatesForModel: ['Сверка тестов с claims'],
      runtimeGateRows: [{ name: RECONCILE_GATE, status: '✅', result: 'рантайм' }],
    });
    ok(text.includes('| Сверка тестов с claims | ‹✅/❌/⏭› |'), text);
    ok(text.includes(`| ${RECONCILE_GATE} | ✅ |`), text);
  });
});

describe('счётчик повторов bash и цикл TDD', () => {
  const ctx: PolicyContext = {
    projectRoot: '/proj',
    stage: 'chunk',
    sdlcDir: '.sdlc/x',
    planFiles: null,
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Bash'],
    mcpTools: [],
  };
  it('принятая правка между падениями теста обнуляет счётчик', async () => {
    const g = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    g.setAutoApprove('r1', 'chunk', { planWrites: false, bash: true, rest: false, mcpWrites: false });
    const call: NormalizedCall = { kind: 'bash', command: 'npm test' };
    for (let i = 0; i < 5; i++) {
      const d = await g.request({ runId: 'r1', stage: 'chunk', requestId: `t${i}`, toolName: 'Bash', rawInput: {}, call, ctx });
      ok(d.allowed, `прогон ${i + 1} после правки`);
      g.recordBashResult('r1', 'npm test', false);
      g.noteTreeChanged('r1');
    }
  });
});

describe('вывод инструмента, сохранённый харнессом (флоу sdk)', () => {
  const base: PolicyContext = {
    projectRoot: 'D:/work/proj',
    stage: 'chunk',
    sdlcDir: '.sdlc/demo',
    planFiles: null,
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Read'],
    mcpTools: [],
  };
  const read = (path: string): NormalizedCall => ({ kind: 'read', path, range: null });
  const root = 'C:/Users/u/.claude/projects/D--work-proj';

  it('читается только `<сессия>/tool-results/…` и только во флоу sdk', () => {
    const sdk = { ...base, harnessResultsRoot: root };
    ok(evaluate(read(`${root}/abc-123/tool-results/bash-1.txt`), sdk).ok);
    ok(!evaluate(read(`${root}/abc-123.jsonl`), sdk).ok, 'транскрипт сессии закрыт');
    ok(!evaluate(read(`${root}/abc-123/tool-results/bash-1.txt`), base).ok, 'флоу loop таких путей не знает');
  });
});
