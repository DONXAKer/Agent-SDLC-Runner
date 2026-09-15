/**
 * `touchSectionProblem` — страж этапа `explore` для незакрытой секции задачи
 * «Что придётся тронуть».
 *
 * Секция исключена из предусловия входа в разведку (`filledExceptTouchSection`), но
 * предусловие входа в план считает её обычным `filled`. Пока закрытия секции не требовал
 * никто, `intent` и `explore` уходили зелёными, а виток умирал на входе `plan` с
 * обвинением этапа `intent` (разбор серии v9, 2026-09-15: 5 прогонов из 5).
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { touchSectionProblem } from '../src/run/stages/explore.ts';
import { intentPlaceholderProblem } from '../src/run/stages.ts';
import type { StageContext } from '../src/run/stages.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(intentText: string | null): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-touch-section-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  if (intentText !== null) writeFileSync(paths.intent, intentText);
  return { paths, chunk: 1, attempt: 1 };
}

/** Ровно то, что осталось в `intent.md` во всех пяти прогонах серии v9. */
const TOUCH_LEFT = [
  '# Задача: демо',
  '',
  '- **Итог:** бесплатная доставка для крупных отправлений',
  '- **Зачем:** снизить отказы на кассе',
  '',
  '## Что придётся тронуть',
  '',
  '- ‹path/to/file› — ‹что здесь меняем›',
  '',
].join('\n');

const TOUCH_FILLED = [
  '# Задача: демо',
  '',
  '- **Итог:** бесплатная доставка для крупных отправлений',
  '- **Зачем:** снизить отказы на кассе',
  '',
  '## Что придётся тронуть',
  '',
  '- `src/tariffs.ts` — правило бесплатной доставки',
  '',
].join('\n');

describe('touchSectionProblem', () => {
  it('задачи нет на диске — н/п (ловит предусловие входа)', () => {
    strictEqual(touchSectionProblem(ctx(null)), null);
  });

  it('секция заполнена строкой карты — проблемы нет', () => {
    strictEqual(touchSectionProblem(ctx(TOUCH_FILLED)), null);
  });

  it('образец секции остался — находка с числом мест', () => {
    const problem = touchSectionProblem(ctx(TOUCH_LEFT));
    ok(problem !== null);
    ok(problem.includes('Что придётся тронуть'), problem ?? '');
    ok(problem.includes('2'), problem ?? '');
  });

  // Тот самый расход двух счётчиков, ради которого страж и заведён: этап 1 эту секцию
  // не считает и уходит зелёным — значит спросить о ней обязан этап 2, иначе не спросит
  // никто, а этап 4 на входе её посчитает.
  it('страж этапа 1 ту же задачу проблемой не считает', () => {
    strictEqual(intentPlaceholderProblem(ctx(TOUCH_LEFT)), null);
  });
});
