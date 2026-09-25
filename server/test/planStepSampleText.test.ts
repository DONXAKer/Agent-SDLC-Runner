/**
 * `planStepSampleTextProblem` — страж этапа `plan` (Р5, серия local6 2026-09-24): явная
 * форма шага (`### Шаг N`), где поле `файл` осталось строкой-образцом из
 * `templates/plan.template.md` (`src/tariffs.ts`/`priceFor`/`test/oversize.test.ts`),
 * не заменённой на путь реальной задачи. Найдено дважды на живой серии: модель меняла
 * заголовок шага и «действие», но оставляла файл/символ/закрывает/проверка дословно
 * текстом образца — chunk потом читал `test/oversize.test.ts` как реальный файл.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { planStepSampleTextProblem } from '../src/run/stages/plan.ts';
import type { StageContext } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(planText: string | null, realFiles: string[] = []): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-plan-sample-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  for (const f of realFiles) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), '');
  }
  const paths = new WitokPaths(root, 'demo');
  if (planText !== null) writeFileSync(paths.plan, planText);
  return { paths, chunk: 1, attempt: 1 };
}

function planWithStep(stepBlock: string, touchRow = '| `src/vat.ts` | новый модуль расчёта НДС |'): string {
  return [
    '# План: демо',
    '',
    '## Шаги',
    '',
    '```',
    stepBlock,
    '```',
    '',
    '## files_to_touch',
    '',
    '| Путь | Что делаем |',
    '|---|---|',
    touchRow,
    '',
  ].join('\n');
}

// Ровно то, что осталось на живом прогоне: заголовок и «действие» модель поменяла,
// файл/символ/закрывает/проверка — дословно образец шаблона.
const LEAKED_STEP = [
  '### Шаг 1 — создать `src/vat.ts:calculateVat`',
  '- файл: src/tariffs.ts (новый | существующий)',
  '- символ: priceFor',
  '- действие: Добавить поддержку НДС в биллинг',
  '- закрывает: claim-2, claim-4',
  '- проверка: `node --test test/oversize.test.ts` · ожидаемо: зелёный',
  '- факты человека: н/п',
].join('\n');

const REAL_STEP = [
  '### Шаг 1 — создать `src/vat.ts:calculateVat`',
  '- файл: src/vat.ts (новый)',
  '- символ: calculateVat',
  '- действие: Добавить функцию расчёта НДС',
  '- закрывает: claim-2',
  '- проверка: `node --test test/invoice-vat.test.ts` · ожидаемо: зелёный',
  '- факты человека: н/п',
].join('\n');

describe('planStepSampleTextProblem', () => {
  it('нет plan.md на диске — н/п (ловит соседнее предусловие)', () => {
    strictEqual(planStepSampleTextProblem(ctx(null)), null);
  });

  it('план без явных шагов (только files_to_touch) — сверять не с чем', () => {
    strictEqual(planStepSampleTextProblem(ctx(planWithStep('1. обычный пункт списка, не явная форма'))), null);
  });

  it('файл шага — строка-образец шаблона, не в files_to_touch, не на диске, не новый — находка', () => {
    const problem = planStepSampleTextProblem(ctx(planWithStep(LEAKED_STEP)));
    ok(problem !== null);
    ok(problem!.includes('src/tariffs.ts'), problem ?? '');
    ok(problem!.includes('строку-образец'), problem ?? '');
  });

  it('тот же образец, но файл помечен явным «новый» — не находка (модель хотя бы решила)', () => {
    const step = LEAKED_STEP.replace('src/tariffs.ts (новый | существующий)', 'src/tariffs.ts (новый)');
    strictEqual(planStepSampleTextProblem(ctx(planWithStep(step))), null);
  });

  it('файл шага реально существует на диске — не находка', () => {
    const problem = planStepSampleTextProblem(ctx(planWithStep(LEAKED_STEP), ['src/tariffs.ts']));
    strictEqual(problem, null);
  });

  it('файл шага в files_to_touch — не находка (обычный путь, ничего не образец)', () => {
    strictEqual(
      planStepSampleTextProblem(ctx(planWithStep(LEAKED_STEP, '| `src/tariffs.ts` | добавить наценку |'))),
      null,
    );
  });

  it('реальный, доведённый шаг задачи — не находка', () => {
    strictEqual(planStepSampleTextProblem(ctx(planWithStep(REAL_STEP))), null);
  });
});
