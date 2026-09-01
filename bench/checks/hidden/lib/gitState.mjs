/**
 * Состояние git-дерева цели — для кейсов «правильный исход: НЕ трогать код».
 *
 * `already-done`, `broken-test`, `wrong-diagnosis` проверяют, что модель не изменила
 * файлы, которые менять не следовало. Рабочая копия витка — git-репозиторий
 * (`bench/src/workspace.ts` делает `git init` и ветку), пристинная фикстура в
 * `bench/fixtures/<family>` — нет. Кейсы на пристинной обязаны ПРОПУСКАТЬСЯ (`t.skip`), не
 * зеленеть и не краснеть: `bench/src/hiddenTests.ts` разбирает `# SKIP` и не считает их.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function gitAvailable(target) {
  return existsSync(join(target, '.git'));
}

function git(target, args) {
  const r = spawnSync('git', args, { cwd: target, encoding: 'utf8', windowsHide: true });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} в ${target}: код ${r.status}\n${r.stderr}`);
  return r.stdout;
}

/** `git status --porcelain -- <paths>` цели; пустая строка — дерево по этим путям не тронуто (включая untracked). */
export function porcelain(target, paths = []) {
  return git(target, ['status', '--porcelain', '--', ...paths]).trim();
}

/** `git diff --stat HEAD -- <paths>`; пусто — отслеживаемые файлы по путям не менялись. */
export function diffStat(target, paths = []) {
  return git(target, ['diff', '--stat', 'HEAD', '--', ...paths]).trim();
}

/**
 * Пропускает кейс на цели без `.git` и возвращает `false`; иначе `true`. Вызывать первой
 * строкой кейса: `if (!skipUnlessGit(t, target)) return;`.
 */
export function skipUnlessGit(t, target) {
  if (gitAvailable(target)) return true;
  t.skip('цель без .git — нетронутость дерева проверяется только в рабочей копии витка');
  return false;
}
