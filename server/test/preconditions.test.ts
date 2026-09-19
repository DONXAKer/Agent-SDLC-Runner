/**
 * `hasOpenQuestions` — страж, читающий чек-боксы «- [ ] вопрос» тем же классом строки, что
 * `artifacts/humanFacts.ts::CHECKBOX_LINE_RE` парсит/закрывает. До ревью code-review-all
 * (2026-09-19) регэкспы расходились: `hasOpenQuestions` принимал ЛЮБОЕ число пробелов между
 * скобками, `CHECKBOX_LINE_RE` — ровно один символ. Вопрос вида `- [  ] …` (два пробела)
 * страж видел открытым, а механизм задавания/закрытия — не видел вовсе: вопрос навсегда
 * оставался «есть, но незакрываемым».
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasOpenQuestions } from '../src/run/stages/preconditions.ts';

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
