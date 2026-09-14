/**
 * `intentPlaceholderProblem` — страж этапа `intent` для незакрытых мест вне секции
 * «Что придётся тронуть».
 *
 * Ровно тот же вердикт, что уже даёт предусловие входа в `explore`
 * (`filledExceptTouchSection`), но здесь он приходит модели в её собственном ходу на
 * самом `intent`, а не после того, как исполнитель ушёл. `notDone()` (`Run.ts`) видит
 * только «файл тронут vs пустой бланк» — дозаполнение, тронувшее intent.md и оставившее
 * хотя бы одно место, уходило зелёным до входа в `explore` СЛЕДУЮЩЕГО цикла (живой разбор
 * серии v5, 2026-09-14: 4 из 22 прогонов упёрлись ровно в это).
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { intentPlaceholderProblem } from '../src/run/stages.ts';
import type { StageContext } from '../src/run/stages.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(intentText: string | null): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-intent-placeholder-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  if (intentText !== null) writeFileSync(paths.intent, intentText);
  return { paths, chunk: 1, attempt: 1 };
}

const INTENT_FILLED = [
  '# Задача: демо',
  '',
  '- **Итог:** бесплатная доставка для крупных отправлений',
  '- **Зачем:** снизить отказы на кассе',
  '',
  '## Что придётся тронуть',
  '',
  '‹заполняет разведка на этапе 2›',
  '',
].join('\n');

const INTENT_ONE_FIELD_LEFT = [
  '# Задача: демо',
  '',
  '- **Итог:** бесплатная доставка для крупных отправлений',
  '- **Зачем:** ‹почему сейчас›',
  '',
  '## Что придётся тронуть',
  '',
  '‹заполняет разведка на этапе 2›',
  '',
].join('\n');

describe('intentPlaceholderProblem', () => {
  it('intent.md нет на диске — н/п (ловит соседнее предусловие)', () => {
    strictEqual(intentPlaceholderProblem(ctx(null)), null);
  });

  it('все поля заполнены, «Что придётся тронуть» законно пуста — проблемы нет', () => {
    strictEqual(intentPlaceholderProblem(ctx(INTENT_FILLED)), null);
  });

  it('одно поле осталось плейсхолдером вне «Что придётся тронуть» — находка, не null', () => {
    const problem = intentPlaceholderProblem(ctx(INTENT_ONE_FIELD_LEFT));
    ok(problem !== null);
    ok(problem.includes('intent.md'), problem ?? '');
    ok(problem.includes('1'), problem ?? '');
  });
});
