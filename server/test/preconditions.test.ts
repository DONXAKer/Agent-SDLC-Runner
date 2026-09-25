/**
 * `hasOpenQuestions` — страж, читающий чек-боксы «- [ ] вопрос» тем же классом строки, что
 * `artifacts/humanFacts.ts::CHECKBOX_LINE_RE` парсит/закрывает. До ревью code-review-all
 * (2026-09-19) регэкспы расходились: `hasOpenQuestions` принимал ЛЮБОЕ число пробелов между
 * скобками, `CHECKBOX_LINE_RE` — ровно один символ. Вопрос вида `- [  ] …` (два пробела)
 * страж видел открытым, а механизм задавания/закрытия — не видел вовсе: вопрос навсегда
 * оставался «есть, но незакрываемым».
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { artifactPlaceholders, hasOpenQuestions, intentFilled, intentPlaceholderCount } from '../src/run/stages/preconditions.ts';
import type { StageContext } from '../src/run/stages/types.ts';

describe('hasOpenQuestions', () => {
  it('обычный незакрытый чек-бокс — открыт', () => {
    strictEqual(hasOpenQuestions('- [ ] вопрос?\n'), true);
  });

  it('закрытый чек-бокс — не открыт', () => {
    strictEqual(hasOpenQuestions('- [x] вопрос? — ответ\n'), false);
    strictEqual(hasOpenQuestions('- [X] вопрос? — ответ\n'), false);
  });

  it('два пробела между скобками — тоже открыт (регрессия ревью, 2026-09-19)', () => {
    strictEqual(hasOpenQuestions('- [  ] вопрос?\n'), true);
  });

  it('пустые скобки без единого пробела — тоже открыт', () => {
    strictEqual(hasOpenQuestions('- [] вопрос?\n'), true);
  });

  it('текст без чек-боксов вовсе — не открыт', () => {
    strictEqual(hasOpenQuestions('# Задача\nобычный текст\n'), false);
  });

  it('маркеры `*`/`+` тоже считаются', () => {
    strictEqual(hasOpenQuestions('* [ ] вопрос?\n'), true);
    strictEqual(hasOpenQuestions('+ [ ] вопрос?\n'), true);
  });
});

/**
 * `intentFilled` — одна функция полноты `intent.md` на страж этапа 1 и предусловия
 * этапов 2/4. Класс дефекта, который она закрывает (test28, `qwen3-8b`, 2026-09-23):
 * на мелком контуре страж этапа 1 считал без секции «Что придётся тронуть» (её заполняет
 * разведка), а вход в `plan` считал всё — этап 1 уходил `ok⚠`, `plan` не стартовал по тому
 * же файлу.
 */
describe('intentFilled: одна функция полноты intent.md на страж этапа 1 и входы в explore/plan', () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function ctx(contour: 'полный' | 'мелкий'): StageContext {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-intent-filled-')));
    roots.push(root);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    const paths = new WitokPaths(root, 'demo');
    writeFileSync(
      paths.intent,
      [
        '# Задача: демо',
        '',
        `- **Контур:** ${contour}`,
        '- **Итог:** бесплатная доставка',
        '',
        '## Что придётся тронуть',
        '',
        '‹заполняет разведка на этапе 2›',
        '',
      ].join('\n'),
    );
    return { paths, chunk: 1, attempt: 1 };
  }

  it('полный контур: до разведки секция «Что придётся тронуть» законно пуста, после — обязана быть заполнена', () => {
    const c = ctx('полный');
    strictEqual(intentFilled('x', false).check(c), null);
    ok(intentFilled('x', true).check(c)?.includes('незаполненных мест: 1'));
  });

  it('мелкий контур: секцию не заполняет никто — вход в plan считает так же, как страж этапа 1', () => {
    const c = ctx('мелкий');
    strictEqual(intentFilled('x', false).check(c), null);
    strictEqual(intentFilled('x', true).check(c), null);
    strictEqual(intentPlaceholderCount(c, readFileSync(c.paths.intent, 'utf8'), true), 0);
  });

  it('незакрытое место вне секции считается на любом контуре и в любой точке', () => {
    const c = ctx('мелкий');
    writeFileSync(c.paths.intent, readFileSync(c.paths.intent, 'utf8').replace('бесплатная доставка', '‹итог›'));
    ok(intentFilled('x', false).check(c)?.includes('незаполненных мест: 1'));
    ok(intentFilled('x', true).check(c)?.includes('незаполненных мест: 1'));
  });
});

// `readiness.md` — общий файл: intent пишет «Прогон 1», plan — «Прогон 2». Дашборд и живая
// страница обязаны считать intent завершённым по заполненности ЕГО секции, не по секции
// плана, которая до plan.md законно пуста (аналог intentFilled/test28, code-review-all
// 2026-09-26).
describe('artifactPlaceholders: readiness.md считается по секции своего этапа', () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function ctx(): StageContext {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-readiness-placeholders-')));
    roots.push(root);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    const paths = new WitokPaths(root, 'demo');
    writeFileSync(
      paths.readiness,
      [
        '## Прогон 1',
        '- **Вердикт прогона 1:** готова',
        '',
        '## Прогон 2',
        '- **Вердикт прогона 2:** ‹готова / не готова›',
        '',
      ].join('\n'),
    );
    return { paths, chunk: 1, attempt: 1 };
  }

  it('intent: прогон 1 заполнен — без плейсхолдеров, хотя прогон 2 ещё пуст', () => {
    const c = ctx();
    deepStrictEqual(artifactPlaceholders(c.paths.readiness, c, 'intent'), { exists: true, placeholders: 0 });
  });

  it('plan: прогон 2 не заполнен — плейсхолдер считается', () => {
    const c = ctx();
    deepStrictEqual(artifactPlaceholders(c.paths.readiness, c, 'plan'), { exists: true, placeholders: 1 });
  });

  it('без stageId (общий список артефактов без привязки к этапу) — счёт по всему файлу', () => {
    const c = ctx();
    deepStrictEqual(artifactPlaceholders(c.paths.readiness, c), { exists: true, placeholders: 1 });
  });

  it('файла нет — exists: false независимо от stageId', () => {
    const c = ctx();
    strictEqual(artifactPlaceholders(join(c.paths.dir, 'нет-файла.md'), c, 'intent').exists, false);
  });
});
