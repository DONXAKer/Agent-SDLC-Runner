/**
 * Реальные шаблоны эталона методологии через разборщики раннера (code-review-all
 * 2026-09-23). Зелёный прогон «с эталоном» прежде ложно успокаивал: таблицу «Гейты»
 * актуальной формы код не заполнял, `example/gates.md` эталона давал красный вердикт,
 * гейты шаблона без исполнителя блокировали старт — а тесты гоняли самописные образцы
 * старой формы. Путь к эталону — из окружения или из конфига (`runner.local.json`), а не
 * только из `SDLC_METHODOLOGY_DIR`: иначе на машине с настроенным эталоном тест молча
 * пропускался. Эталона нет — пропуск с названной причиной.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { GateRunResult, VerdictInput } from '@sdlc-runner/shared';

import { loadConfig } from '../src/config/load.ts';
import { builtinFor } from '../src/gates/builtin/index.ts';
import { openDebt, parseGates, unimplementedGates } from '../src/gates/gatesFile.ts';
import { readinessVerdict } from '../src/run/stages/preconditions.ts';
import { MODEL_REPORTED_GATES, RECONCILE_GATE, REVIEW_GATE } from '../src/run/stages/verify/gates.ts';
import { missingClaimIds } from '../src/run/stages/verify/reviewer.ts';
import { autofillVerificationReport, readReportVerdict, writeVerdictSection } from '../src/run/verifyAutofill.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';

function methodologyDir(): string | null {
  const fromEnv = process.env['SDLC_METHODOLOGY_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return loadConfig().runner.methodologyDir;
  } catch {
    return null;
  }
}

const dir = methodologyDir();
const template = (name: string): string | null => {
  if (dir === null) return null;
  const p = join(dir, 'templates', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const REPORT = template('verification-report.template.md');
const GATES_TPL = template('gates.template.md');
const READINESS = template('readiness.template.md');
const EXAMPLE_GATES = dir !== null && existsSync(join(dir, 'example', 'gates.md')) ? readFileSync(join(dir, 'example', 'gates.md'), 'utf8') : null;
const skip = (t: string | null): string | false => (t === null ? 'эталон методологии не найден (SDLC_METHODOLOGY_DIR / runner.local.json)' : false);

const gate = (name: string, status: '✅' | '❌' | '⏭'): GateRunResult => ({
  name,
  status,
  command: null,
  exitCode: 0,
  durationMs: 0,
  lastLine: 'ok',
  envBlocked: false,
});

describe('реальный шаблон отчёта приёмки', () => {
  it('таблица «Гейты» актуальной формы заполняется: прогнанные гейты, строка рантайма и строка ревью модели', { skip: skip(REPORT) }, () => {
    const { text, filled } = autofillVerificationReport(REPORT!, [gate('Сборка', '✅'), gate('Тесты', '❌')], {
      chunk: 1,
      attempt: 1,
      slug: 'demo',
      attemptBudget: 3,
      gatesForModel: [REVIEW_GATE],
      runtimeGateRows: [{ name: RECONCILE_GATE, status: '✅', result: 'рантайм' }],
    });
    ok(filled > 0);
    ok(!text.includes('| ‹имя из набора› |'), 'строка-образец развёрнута');
    ok(/\| Сборка \| ✅ \|/.test(text), text);
    ok(/\| Тесты \| ❌ \|/.test(text), text);
    ok(text.includes(`| ${RECONCILE_GATE} | ✅ |`), text);
    ok(text.includes(`| ${REVIEW_GATE} | ‹✅/❌/⏭› |`), 'строка ревью остаётся модели');
  });

  it('бланк вердикта — не вердикт; записанный рантаймом — читается', { skip: skip(REPORT) }, () => {
    strictEqual(readReportVerdict(REPORT!), null);
    const { text, changed } = writeVerdictSection(REPORT!, { passed: false, action: 'retry', reasons: ['гейт «Тесты» ❌'] });
    ok(changed);
    strictEqual(readReportVerdict(text), 'failed');
  });
});

describe('реальный набор гейтов эталона', () => {
  it('example/gates.md: долг закрыт — пример эталона не роняет вердикт', { skip: skip(EXAMPLE_GATES) }, () => {
    deepStrictEqual(openDebt(parseGates(EXAMPLE_GATES!)), []);
  });

  it('гейты шаблона без механики рантайма не блокируют старт витка', { skip: skip(GATES_TPL) }, () => {
    // Все строки шаблона «включены» — худший случай для проверки «исполнить нечем».
    const enabled = GATES_TPL!.replace(/\| ‹да\/нет› \|/g, '| да |');
    const problems = unimplementedGates(parseGates(enabled), (n) => builtinFor(n) !== null, [
      REVIEW_GATE,
      RECONCILE_GATE,
      ...MODEL_REPORTED_GATES,
    ]);
    deepStrictEqual(problems, []);
  });
});

describe('реальный шаблон готовности', () => {
  it('бланк вердикта готовности — не «не готова» и не «готова»', { skip: skip(READINESS) }, () => {
    strictEqual(readinessVerdict(READINESS!, 1), null);
    strictEqual(readinessVerdict(READINESS!, 2), null);
    strictEqual(readinessVerdict('**Вердикт прогона 1:** не готова — чинить лист', 1), 'not');
    strictEqual(readinessVerdict('**Вердикт прогона 2:** готова', 2), 'ready');
  });
});

describe('ответ рецензента и класс среды (без эталона)', () => {
  it('missingClaimIds: граница по цифре и регистр', () => {
    deepStrictEqual(missingClaimIds('CLAIM-1 ✅, claim-12 ❌', ['claim-1', 'claim-2', 'claim-12']), ['claim-2']);
  });

  const input = (over: Partial<VerdictInput>): VerdictInput => ({
    gates: [],
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
    ...over,
  });

  it('blocked_env — только гейты сборки и тестов; незапуск прочего гейта — обычный retry', () => {
    const blocked = (name: string) => ({ name, status: '⏭' as const, inapplicableSignedBy: null, envBlocked: true });
    strictEqual(computeVerdict(input({ gates: [blocked('Тесты')] }), []).action, 'blocked_env');
    strictEqual(computeVerdict(input({ gates: [blocked('Линт экосистемы')] }), []).action, 'retry');
  });
});
