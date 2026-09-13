/**
 * `filesToTouchProblem` — страж этапа `plan` для пустого `files_to_touch`.
 *
 * Ровно тот же вердикт, что уже даёт `Run.blockers()` на входе в `chunk` («PlanScope
 * выключился бы молча»), но здесь он приходит модели в её собственном ходу на самом
 * `plan`, а не после того, как планировщик ушёл. Живой замер `gemma-4-e4b`/`security-bait`
 * (2026-09-13): план закрылся зелёным (`ok:true`), а бесполезность (пустой список файлов)
 * вскрылась только на входе в `chunk`, потратив холостой цикл.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { filesToTouchProblem } from '../src/run/stages.ts';
import type { StageContext } from '../src/run/stages.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(planText: string | null): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-files-to-touch-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  if (planText !== null) writeFileSync(paths.plan, planText);
  return { paths, chunk: 1, attempt: 1 };
}

const PLAN_WITH_FILES = [
  '# План: демо',
  '',
  '## files_to_touch',
  '',
  '| Путь | Что делаем |',
  '|---|---|',
  '| `src/tariffs.ts` | добавить surcharge |',
  '',
].join('\n');

const PLAN_EMPTY = [
  '# План: демо',
  '',
  '## files_to_touch',
  '',
  '| Путь | Что делаем |',
  '|---|---|',
  '| ‹path/to/file› | ‹что здесь меняем› |',
  '',
].join('\n');

describe('filesToTouchProblem', () => {
  it('план без плана на диске — н/п (ловит соседнее предусловие)', () => {
    strictEqual(filesToTouchProblem(ctx(null)), null);
  });

  it('files_to_touch с хотя бы одним путём — проблемы нет', () => {
    strictEqual(filesToTouchProblem(ctx(PLAN_WITH_FILES)), null);
  });

  it('пустой (плейсхолдерный) files_to_touch — находка, не null', () => {
    const problem = filesToTouchProblem(ctx(PLAN_EMPTY));
    ok(problem !== null);
    ok(problem.includes('files_to_touch'), problem ?? '');
    ok(problem.includes('PlanScope'), problem ?? '');
  });
});
