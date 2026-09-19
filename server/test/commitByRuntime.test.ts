/**
 * Состав и сообщение локального коммита этапа 7 — чистые функции `commitByRuntime.ts`.
 * Сетевой/дисковый путь (`commitByRuntime` целиком: git, `requestApproval`) здесь не
 * гоняется — тестируется то, что решает состав, а не сам git.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commitMessageFor, commitTargets, posixShellQuote } from '../src/run/commitByRuntime.ts';

describe('commitTargets', () => {
  const planFiles = ['src/app.ts', 'src/util.ts'];
  const sdlcPrefix = '.sdlc/demo/';
  const posixRoot = '/proj';
  const windowsRoot = 'D:/proj';

  it('берёт изменённые файлы плана и всё под каталогом витка', () => {
    const changed = ['src/app.ts', 'src/unrelated.ts', '.sdlc/demo/plan.md', '.sdlc/other/plan.md'];
    deepStrictEqual(commitTargets(changed, planFiles, sdlcPrefix, posixRoot), ['src/app.ts', '.sdlc/demo/plan.md']);
  });

  it('файл вне плана и вне каталога витка не идёт в коммит', () => {
    deepStrictEqual(commitTargets(['README.md'], planFiles, sdlcPrefix, posixRoot), []);
  });

  it('путь плана с обратными слэшами сравнивается как posix', () => {
    deepStrictEqual(commitTargets(['src\\app.ts'.replace(/\\/g, '/')], planFiles, sdlcPrefix, posixRoot), ['src/app.ts']);
  });

  it('пусто на входе — пусто на выходе', () => {
    deepStrictEqual(commitTargets([], planFiles, sdlcPrefix, posixRoot), []);
  });

  // Регрессия ревью (2026-09-18): раньше пересечение считалось сырым `Set` без
  // `normalizePlanPath`/`pathsEqual` — путь плана, отличающийся регистром или префиксом
  // `./`, молча выпадал из коммита. Теперь используется тот же приём, что `planScope.ts`.

  it('регистр пути на Windows не мешает совпадению (case-insensitive корень)', () => {
    const changed = ['Src/App.ts'];
    deepStrictEqual(commitTargets(changed, ['src/app.ts'], sdlcPrefix, windowsRoot), ['Src/App.ts']);
  });

  it('регистр пути на POSIX-корне ЗНАЧИМ — разный регистр не совпадает', () => {
    const changed = ['Src/App.ts'];
    deepStrictEqual(commitTargets(changed, ['src/app.ts'], sdlcPrefix, posixRoot), []);
  });

  it('префикс «./» в пути плана не мешает совпадению', () => {
    const changed = ['src/app.ts'];
    deepStrictEqual(commitTargets(changed, ['./src/app.ts'], sdlcPrefix, posixRoot), ['src/app.ts']);
  });

  it('путь плана с обратным слэшем (Windows-запись модели) сравнивается как posix', () => {
    const changed = ['src/app.ts'];
    deepStrictEqual(commitTargets(changed, ['src\\app.ts'], sdlcPrefix, posixRoot), ['src/app.ts']);
  });
});

describe('posixShellQuote (регрессия ревью, 2026-09-19: $()/бэктик исполнялись внутри "…")', () => {
  it('подстановка команды `$(...)` экранируется — не раскрывается shell\'ом', () => {
    const quoted = posixShellQuote('$(touch pwned).ts');
    strictEqual(quoted, '"\\$(touch pwned).ts"');
  });

  it('обратные кавычки экранируются — тоже вектор подстановки команды', () => {
    const quoted = posixShellQuote('`touch pwned`.ts');
    strictEqual(quoted, '"\\`touch pwned\\`.ts"');
  });

  it('бэкслеш экранируется ПЕРВЫМ — иначе следующие замены задваивают уже вставленный бэкслеш', () => {
    const quoted = posixShellQuote('a\\$b');
    strictEqual(quoted, '"a\\\\\\$b"');
  });

  it('двойная кавычка по-прежнему экранируется (не регрессия существовавшей защиты)', () => {
    strictEqual(posixShellQuote('a"b'), '"a\\"b"');
  });
});

describe('commitMessageFor', () => {
  it('passed — «приёмка»', () => {
    strictEqual(commitMessageFor('demo', 2, 1, 'passed'), 'sdlc(demo): chunk 2 попытка 1 — приёмка');
  });

  it('aborted — «обрыв витка»', () => {
    strictEqual(commitMessageFor('demo', 1, 3, 'aborted'), 'sdlc(demo): chunk 1 попытка 3 — обрыв витка');
  });
});
