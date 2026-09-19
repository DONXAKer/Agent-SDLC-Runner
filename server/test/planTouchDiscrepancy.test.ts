/**
 * `planTouchDiscrepancyProblem` — страж этапа `plan` (4.1): `files_to_touch` обязан либо
 * совпасть с «Что придётся тронуть» разведки, либо назвать каждое расхождение строкой
 * («Из задачи исключено» / «Добавлено сверх разведки»). План вправе сузить или расширить
 * список (шаблон говорит это прямо) — не вправе разойтись молча.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { planTouchDiscrepancyProblem } from '../src/run/stages/plan.ts';
import type { StageContext } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(intentText: string | null, planText: string | null): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-touch-diff-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  if (intentText !== null) writeFileSync(paths.intent, intentText);
  if (planText !== null) writeFileSync(paths.plan, planText);
  return { paths, chunk: 1, attempt: 1 };
}

const INTENT_TWO_PATHS = [
  '# Задача: демо',
  '',
  '## Что придётся тронуть',
  '_Заполняет агент на разведке._',
  '',
  '- src/tariffs.ts — добавить surcharge',
  '- src/oversize.ts — использовать surcharge',
  '',
].join('\n');

const INTENT_EMPTY = [
  '# Задача: демо',
  '',
  '## Что придётся тронуть',
  '_Заполняет агент на разведке._',
  '',
  '- ‹path/to/file› — ‹что здесь меняем›',
  '',
].join('\n');

function plan(rows: string, extra = ''): string {
  return [
    '# План: демо',
    '',
    '## files_to_touch',
    '',
    '| Путь | Что делаем |',
    '|---|---|',
    rows,
    '',
    extra,
    '',
  ].join('\n');
}

describe('planTouchDiscrepancyProblem', () => {
  it('нет intent.md на диске — н/п (ловит соседнее предусловие)', () => {
    strictEqual(planTouchDiscrepancyProblem(ctx(null, null)), null);
  });

  it('«Что придётся тронуть» пуста (мелкий контур/плейсхолдер) — сверять не с чем', () => {
    strictEqual(planTouchDiscrepancyProblem(ctx(INTENT_EMPTY, plan('| `src/x.ts` | правка |'))), null);
  });

  it('files_to_touch совпадает с разведкой дословно — проблемы нет', () => {
    const p = plan(
      ['| `src/tariffs.ts` | добавить surcharge |', '| `src/oversize.ts` | использовать surcharge |'].join('\n'),
    );
    strictEqual(planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p)), null);
  });

  it('план молча сузил список — находка называет пропущенный путь', () => {
    const p = plan('| `src/tariffs.ts` | добавить surcharge |');
    const problem = planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p));
    ok(problem !== null);
    ok(problem!.includes('src/oversize.ts'), problem ?? '');
    ok(problem!.includes('Из задачи исключено'), problem ?? '');
  });

  it('план сузил список, но объяснил в «Из задачи исключено» — проблемы нет', () => {
    const p = plan(
      '| `src/tariffs.ts` | добавить surcharge |',
      '- **Из задачи исключено**: `src/oversize.ts` — surcharge уже применяется в tariffs.ts',
    );
    strictEqual(planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p)), null);
  });

  it('план молча расширил список — находка называет добавленный путь', () => {
    const p = plan(
      [
        '| `src/tariffs.ts` | добавить surcharge |',
        '| `src/oversize.ts` | использовать surcharge |',
        '| `src/config.ts` | новый флаг |',
      ].join('\n'),
    );
    const problem = planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p));
    ok(problem !== null);
    ok(problem!.includes('src/config.ts'), problem ?? '');
    ok(problem!.includes('Добавлено сверх разведки'), problem ?? '');
  });

  it('план расширил список, но объяснил в «Добавлено сверх разведки» — проблемы нет', () => {
    const p = plan(
      [
        '| `src/tariffs.ts` | добавить surcharge |',
        '| `src/oversize.ts` | использовать surcharge |',
        '| `src/config.ts` | новый флаг |',
      ].join('\n'),
      '- **Добавлено сверх разведки:** `src/config.ts` — нужен флаг включения surcharge',
    );
    strictEqual(planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p)), null);
  });

  it('сужение и расширение одновременно, оба объяснены — проблемы нет', () => {
    const p = plan(
      ['| `src/tariffs.ts` | добавить surcharge |', '| `src/config.ts` | новый флаг |'].join('\n'),
      [
        '- **Из задачи исключено**: `src/oversize.ts` — не понадобился',
        '- **Добавлено сверх разведки:** `src/config.ts` — нужен флаг',
      ].join('\n'),
    );
    strictEqual(planTouchDiscrepancyProblem(ctx(INTENT_TWO_PATHS, p)), null);
  });
});
