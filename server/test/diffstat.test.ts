/**
 * `diffstat` — та же форма, что у `sdlc_common.diffstat` методологии: заголовки читаются до
 * первого `@@`, `--- /dev/null` — новый файл, `+++ /dev/null` — удалённый, строки `++…`/`--…`
 * внутри hunk'ов заголовками не считаются.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffstat, unquoteGitPath } from '../src/diff/diffstat.ts';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+2',
  '+++ строка кода с плюсами',
  ' three',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+fresh',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

describe('diffstat', () => {
  it('файлы, счёт по файлам, удалённые отдельно', () => {
    const d = diffstat(PATCH);
    strictEqual(d.files, 3);
    strictEqual(d.added, 3);
    strictEqual(d.deleted, 2);
    deepStrictEqual(d.paths, ['gone.txt', 'new.txt', 'src/a.ts']);
    deepStrictEqual(d.deleted_paths, ['gone.txt']);
    deepStrictEqual(d.per_file['src/a.ts'], { added: 2, deleted: 1, new: false, deleted_entirely: false });
    deepStrictEqual(d.per_file['new.txt'], { added: 1, deleted: 0, new: true, deleted_entirely: false });
    deepStrictEqual(d.per_file['gone.txt'], { added: 0, deleted: 1, new: false, deleted_entirely: true });
  });

  it('пустой патч — нули', () => {
    deepStrictEqual(diffstat(''), { files: 0, added: 0, deleted: 0, paths: [], deleted_paths: [], per_file: {} });
  });

  it('путь в кавычках с октальными эскейпами разворачивается', () => {
    strictEqual(unquoteGitPath('"src/\\320\\260.ts"'), 'src/а.ts');
    strictEqual(unquoteGitPath('src/plain.ts'), 'src/plain.ts');
    const d = diffstat(['diff --git "a/src/\\320\\260.ts" "b/src/\\320\\260.ts"', '--- "a/src/\\320\\260.ts"', '+++ "b/src/\\320\\260.ts"', '@@ -1 +1 @@', '-x', '+y', ''].join('\n'));
    deepStrictEqual(d.paths, ['src/а.ts']);
  });
});
