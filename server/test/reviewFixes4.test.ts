/**
 * Регрессии ревью code-review-all 2026-09-23 по волнам 1–3 (вердикт на диске — отдельно,
 * `verdictOnDisk.test.ts`). Каждый кейс воспроизводит находку, подтверждённую до правки.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult, NormalizedCall, PolicyContext, VerdictInput } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { evaluate } from '../src/policy/index.ts';
import { normalize } from '../src/exec/normalize.ts';
import { compileSearchFilter } from '../src/policy/paths.ts';
import { readinessVerdict } from '../src/run/stages/preconditions.ts';
import { RECONCILE_GATE, reportedBy } from '../src/run/stages/verify/gates.ts';
import { autofillVerificationReport } from '../src/run/verifyAutofill.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';

/** Вердикт, где единственная причина красного — незапуск гейта `name` из-за среды. */
const envBlockedInput = (name: string): VerdictInput => ({
  // Улика инструмента обязательна: без неё незапуск — обычный красный (`SDLC.md`).
  gates: [{ name, status: '⏭', inapplicableSignedBy: null, envBlocked: true, missingTool: 'bash: java: command not found' }],
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

describe('класс среды для blocked_env — слово в любом месте имени, не подстрока', () => {
  for (const name of [
    'Юнит-тесты',
    'Интеграционные тесты',
    'Сборка/тесты',
    'Тесты,линт',
    'Проверка компиляции',
    'Установка зависимостей',
    'Зависимости (npm ci)',
  ]) {
    it(`«${name}» — среда`, () => strictEqual(computeVerdict(envBlockedInput(name), []).action, 'blocked_env'));
  }
  for (const name of [
    'Аудит зависимостей',
    'Сверка тестов с claims',
    'Граф зависимостей без циклов',
    'Циклические зависимости',
    'Нет новых зависимостей',
  ]) {
    it(`«${name}» — не среда: обычный retry`, () => strictEqual(computeVerdict(envBlockedInput(name), []).action, 'retry'));
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
    strictEqual(reportedBy({ name: RECONCILE_GATE, command: null }), 'runtime');
    // «Сверка тестов с claims» исполняется встроенной реализацией (порт эталона), не моделью.
    strictEqual(reportedBy({ name: 'Сверка тестов с claims', command: null }), null);
    strictEqual(reportedBy({ name: 'Проектные инварианты как ассерты', command: null }), 'model');
    strictEqual(reportedBy({ name: 'Ревью независимым агентом', command: null }), 'model');
    strictEqual(reportedBy({ name: 'Тесты', command: null }), null);
    // Команда в обратных кавычках побеждает имя: строку исполняет она.
    strictEqual(reportedBy({ name: 'Проектные инварианты как ассерты', command: 'npm run invariants' }), null);
    // Ревью — всегда факт прогона рецензента: строку с командой тоже заполняет модель.
    strictEqual(reportedBy({ name: 'Ревью независимым агентом', command: 'echo review' }), 'model');
    const report = '## Гейты\n\n| Гейт | Статус | Результат |\n|---|---|---|\n| ‹имя из набора› | ‹✅/❌/⏭› | ‹результат› |\n';
    const ran: GateRunResult = { name: 'Тесты', status: '✅', command: 'npm test', exitCode: 0, durationMs: 0, lastLine: 'ok', envBlocked: false };
    const { text } = autofillVerificationReport(report, [ran], {
      chunk: 1,
      attempt: 1,
      slug: 'demo',
      attemptBudget: 3,
      gatesForModel: ['Проектные инварианты как ассерты'],
      runtimeGateRows: [{ name: RECONCILE_GATE, status: '✅', result: 'рантайм' }],
    });
    ok(text.includes('| Проектные инварианты как ассерты | ‹✅/❌/⏭› |'), text);
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
  const projects = 'C:/Users/u/.claude/projects/D--work-proj';
  const session = `${projects}/abc-123`;

  it('читается только `tool-results/` ТЕКУЩЕЙ сессии и только во флоу sdk', () => {
    const sdk = { ...base, harnessResultsRoot: session };
    ok(evaluate(read(`${session}/tool-results/bash-1.txt`), sdk).ok);
    ok(!evaluate(read(`${projects}/other-456/tool-results/bash-1.txt`), sdk).ok, 'чужая сессия закрыта');
    ok(!evaluate(read(`${projects}/abc-123.jsonl`), sdk).ok, 'транскрипт сессии закрыт');
    ok(!evaluate(read(`${session}/tool-results/bash-1.txt`), base).ok, 'флоу loop таких путей не знает');
  });
});

describe('ревью da416f4: фильтр поиска, класс среды, готовность', () => {
  it('фильтр в семантике rg --glob: исключающий, несколько шаблонов, запятые, скобки, ./', () => {
    const name = 'verification-report-1-attempt-1.md';
    const path = '.sdlc/demo/verification-report-1-attempt-1.md';
    const hits = (filter: string): boolean => compileSearchFilter(filter, 'grep')(name, path, 'sdlc/demo/' + name);
    strictEqual(hits('!*.ts'), true, '«всё кроме .ts» задевает отчёт');
    strictEqual(hits('!*.md'), false);
    strictEqual(hits('*.ts *.md'), true);
    strictEqual(hits('*.ts,*.md'), true, 'запятая вне скобок делит шаблоны');
    strictEqual(hits('*.{ts,md}'), true);
    strictEqual(hits('{a b,*.md}'), true, 'пробел внутри скобок не делит шаблон');
    strictEqual(hits('*.ts'), false);
    strictEqual(hits('!.sdlc/**'), false, 'явно исключённый каталог витка не задет');
    strictEqual(hits('!**/.sdlc/**'), false);
    strictEqual(compileSearchFilter('./src/*.ts', 'grep')('a.ts', 'src/a.ts'), true);
  });

  it('Grep {type} становится фильтром имён; незнакомый тип — нет', () => {
    const g = normalize('Grep', { pattern: 'x', type: 'ts' });
    ok(g.kind === 'grep' && g.glob === '*.{ts,tsx,mts,cts}', JSON.stringify(g));
    const u = normalize('Grep', { pattern: 'x', type: 'toString' });
    ok(u.kind === 'grep' && u.glob === undefined, JSON.stringify(u));
  });

  it('ослабленное «готова» — не готова; «готова несмотря на…» — готова', () => {
    for (const v of ['не совсем готова — лист', 'не полностью готова', 'почти готова', 'готова не полностью']) {
      strictEqual(readinessVerdict(`**Вердикт прогона 2:** ${v}`, 2), 'not', v);
    }
    for (const v of ['готова несмотря на мелочи', 'готова независимо от ревью']) {
      strictEqual(readinessVerdict(`**Вердикт прогона 2:** ${v}`, 2), 'ready', v);
    }
  });
});
